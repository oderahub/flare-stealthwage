/**
 * StealthWage stream handlers — the confidential core of the product.
 *
 * OP_TYPE STREAM / AUTH_WITHDRAW: decrypt the ECIES-encrypted stream terms,
 * verify them against the commitment, compute cumulative accrual from elapsed
 * time, and return a signature the StreamVault verifies via ecrecover.
 *
 * The enclave is STATELESS by design: the signed digest binds the commitment
 * itself, so a forged terms/commitment pair produces a signature that fails
 * the vault's on-chain commitment check. No chain reads, no durable state —
 * which is exactly what survives TEE restarts.
 *
 * Deps beyond the scaffold: `npm i eciesjs` (secp256k1 ECIES). The TEE keys
 * come from env in simulated mode (TEE_ECIES_PRIVKEY, TEE_SIGNER_PRIVKEY);
 * in real Confidential Space they would be enclave-generated and the pubkeys
 * published at registration.
 */

import { decrypt } from "eciesjs";
import { keccak256, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";
// NOTE: `export { x } from "..."` re-exports without binding locally, so
// anything used in this module's body must also be imported here.
import {
  AUTH_TTL_SECONDS,
  CALLER_AUTH_WINDOW_SECONDS,
  OP_COMMAND_AUTH_SETTLE,
  OP_COMMAND_AUTH_WITHDRAW,
  OP_TYPE_STREAM,
  SETTLE_TAG,
  WITHDRAW_TAG,
  accruedAt,
  buildAuthDigest,
  buildCallerChallenge,
  decodeTerms,
} from "../shared/protocol.js";

/**
 * Protocol constants and encodings live in ../shared/protocol.js — the single
 * source of truth shared with the frontend. Re-exported here so existing
 * importers (tests, scripts) keep working against one definition, not a copy.
 */
export {
  AUTH_TTL_SECONDS,
  CALLER_AUTH_TAG,
  CALLER_AUTH_WINDOW_SECONDS,
  OP_COMMAND_AUTH_SETTLE,
  OP_COMMAND_AUTH_WITHDRAW,
  OP_TYPE_STREAM,
  RATE_SCALE,
  SETTLE_TAG,
  TERMS_ABI,
  WITHDRAW_TAG,
  accruedAt,
  buildAuthDigest,
  buildCallerChallenge,
  commitTo,
  decodeTerms,
  encodeTerms,
  ratePerDayToScaled,
  toScaledRate,
} from "../shared/protocol.js";

interface AuthRequest {
  streamId: string; // decimal string (JSON can't carry uint256)
  vault: `0x${string}`;
  chainId: string;
  commitment: `0x${string}`;
  encryptedTerms: `0x${string}`; // ECIES ciphertext from the StreamCreated event
  issuedAt: string; // unix seconds, must be within CALLER_AUTH_WINDOW
  callerSignature: `0x${string}`; // EIP-191 over buildCallerChallenge()
}

const REQUIRED_FIELDS = [
  "streamId", "vault", "chainId", "commitment", "encryptedTerms",
  "issuedAt", "callerSignature",
];

let authCount = 0; // observability only — never authorization state

export function registerStreamHandlers(framework: Framework): void {
  framework.handle(OP_TYPE_STREAM, OP_COMMAND_AUTH_WITHDRAW, (msg) => authorize(msg, WITHDRAW_TAG));
  framework.handle(OP_TYPE_STREAM, OP_COMMAND_AUTH_SETTLE, (msg) => authorize(msg, SETTLE_TAG));
}

export function reportStreamState(): unknown {
  return { authCount };
}

export function resetStreamState(): void {
  authCount = 0;
}

async function authorize(msg: string, tag: `0x${string}`): Promise<HandlerResult> {
  // 1. Decode
  let req: AuthRequest;
  try {
    const raw = hexToBytes(msg);
    const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [null, 0, "decoding request: expected a JSON object"];
    }
    const unknown = Object.keys(parsed).filter((k) => !REQUIRED_FIELDS.includes(k)).sort();
    if (unknown.length > 0) {
      return [null, 0, `decoding request: unknown field "${unknown[0]}"`];
    }
    for (const f of REQUIRED_FIELDS) {
      if (typeof (parsed as Record<string, unknown>)[f] !== "string") {
        return [null, 0, `decoding request: missing or non-string field "${f}"`];
      }
    }
    req = parsed as unknown as AuthRequest;
  } catch (e) {
    return [null, 0, `decoding request: ${e instanceof Error ? e.message : String(e)}`];
  }

  // 2. Decrypt + verify commitment
  const eciesKey = process.env.TEE_ECIES_PRIVKEY;
  const signerKey = process.env.TEE_SIGNER_PRIVKEY;
  if (!eciesKey || !signerKey) {
    return [null, 0, "TEE keys not configured (TEE_ECIES_PRIVKEY / TEE_SIGNER_PRIVKEY)"];
  }

  let termsHex: `0x${string}`;
  try {
    const plaintext = decrypt(eciesKey, Buffer.from(hexToBytes(req.encryptedTerms)));
    termsHex = bytesToHex(plaintext) as `0x${string}`;
  } catch {
    return [null, 0, "failed to decrypt terms"]; // never echo crypto internals
  }

  if (keccak256(termsHex) !== req.commitment.toLowerCase()) {
    return [null, 0, "terms do not match commitment"];
  }

  let terms: ReturnType<typeof decodeTerms>;
  try {
    terms = decodeTerms(termsHex);
  } catch {
    return [null, 0, "terms blob is malformed"];
  }

  // 2b. Authenticate the caller against the parties named in the terms.
  // Everything needed to reach this point (commitment, ciphertext) is public,
  // so without this check anyone could sample accrual and derive the rate.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let issuedAt: bigint;
  try {
    issuedAt = BigInt(req.issuedAt);
  } catch {
    return [null, 0, "issuedAt must be a unix-seconds integer"];
  }
  const skew = issuedAt > nowSec ? issuedAt - nowSec : nowSec - issuedAt;
  if (skew > CALLER_AUTH_WINDOW_SECONDS) {
    return [null, 0, "caller authorization expired"];
  }

  let caller: string;
  try {
    caller = await recoverMessageAddress({
      message: {
        raw: buildCallerChallenge({
          chainId: BigInt(req.chainId),
          vault: req.vault,
          streamId: BigInt(req.streamId),
          commitment: req.commitment,
          purpose: tag,
          issuedAt,
        }),
      },
      signature: req.callerSignature,
    });
  } catch {
    return [null, 0, "malformed caller signature"];
  }

  const c = caller.toLowerCase();
  // Withdraw: either party may trigger it (funds always go to the recipient,
  // enforced on-chain). Settle: employer only, mirroring cancelStream's
  // msg.sender check so a recipient cannot force a settlement figure.
  const permitted =
    tag === SETTLE_TAG
      ? [terms.employer.toLowerCase()]
      : [terms.recipient.toLowerCase(), terms.employer.toLowerCase()];
  if (!permitted.includes(c)) {
    return [null, 0, "caller is not a party to this stream"];
  }

  // 3. Execute — deterministic accrual, no chain reads. The vault enforces the
  // payout target (stream.recipient) and caps by funded/withdrawn.
  // accruedAt() is the shared fixed-point maths the UI also ticks with, so the
  // number a recipient watches climb is the number the enclave signs.
  const cumulativeAccrued = accruedAt(terms, nowSec);
  const deadline = nowSec + AUTH_TTL_SECONDS;

  // 4. Sign + respond. Digest layout must match StreamVault exactly:
  // keccak256(abi.encode(tag, chainId, vault, streamId, commitment,
  // cumulativeAccrued, deadline)), then EIP-191 prefixed — viem's
  // signMessage({raw}) applies the same prefix the vault reconstructs.
  const digest = buildAuthDigest({
    tag,
    chainId: BigInt(req.chainId),
    vault: req.vault,
    streamId: BigInt(req.streamId),
    commitment: req.commitment,
    cumulativeAccrued,
    deadline,
  });

  const acct = privateKeyToAccount(signerKey as `0x${string}`);
  const signature = await acct.signMessage({ message: { raw: digest } });

  authCount++;
  const resp = {
    streamId: req.streamId,
    cumulativeAccrued: cumulativeAccrued.toString(),
    deadline: deadline.toString(),
    signature,
    // Sign-then-fetch: the caller proved they are a party, so hand back the
    // plaintext terms. This is how the recipient learns their own rate — they
    // cannot decrypt (terms are sealed to the enclave key) — and it lets the UI
    // tick accrual locally instead of polling the enclave.
    terms: termsHex,
  };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}
