/**
 * StealthWage protocol definitions — THE single source of truth.
 *
 * Imported by both the FCC extension (enclave) and the Next frontend. Nothing
 * here may use Node-only APIs (no Buffer, no node:*): this file is bundled into
 * the browser, where the employer seals stream terms.
 *
 * Why one file instead of a folder: the extension resolves with NodeNext (.js
 * suffixes) while Next uses bundler resolution. A single dependency-free module
 * sidesteps cross-resolver relative-import pain. Its only dependency is viem,
 * which both projects already have.
 *
 * ── Do not let these drift ───────────────────────────────────────────────────
 * `buildAuthDigest` must stay byte-identical to StreamVault.sol's inline
 * keccak256(abi.encode(...)). test/StreamVault.t.sol pins it with golden vectors
 * from typescript/scripts/gen-golden-vectors.ts. Drift surfaces on-chain as an
 * opaque "bad TEE signature" revert, which is miserable to debug.
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from "viem";

// --- operation identifiers ---------------------------------------------------

export const OP_TYPE_STREAM = "STREAM";
export const OP_COMMAND_AUTH_WITHDRAW = "AUTH_WITHDRAW";
export const OP_COMMAND_AUTH_SETTLE = "AUTH_SETTLE";

/** Must mirror StreamVault.sol's WITHDRAW_TAG / SETTLE_TAG. */
export const WITHDRAW_TAG = keccak256(toBytes("SW_WITHDRAW_V1"));
export const SETTLE_TAG = keccak256(toBytes("SW_SETTLE_V1"));
export const CALLER_AUTH_TAG = keccak256(toBytes("SW_CALLER_AUTH_V1"));

/** How long a TEE authorization stays valid on-chain. */
export const AUTH_TTL_SECONDS = 600n;
/** How far `issuedAt` may drift before a caller challenge is refused. */
export const CALLER_AUTH_WINDOW_SECONDS = 300n;

// --- terms -------------------------------------------------------------------

/**
 * `employer` and `recipient` are in the blob so the enclave can authenticate
 * callers — it reads no chain state, so the terms are its only source of truth
 * about who the parties are.
 *
 * `salt` is mandatory: rates are low-entropy and an unsalted commitment could
 * be brute-forced straight off the explorer.
 */
export const TERMS_ABI = [
  { type: "address", name: "employer" },
  { type: "address", name: "recipient" },
  { type: "address", name: "token" },
  { type: "uint256", name: "ratePerSecond" },
  { type: "uint256", name: "total" },
  { type: "uint64", name: "startTime" },
  { type: "bytes32", name: "salt" },
] as const;

export interface StreamTerms {
  employer: Hex;
  recipient: Hex;
  token: Hex;
  ratePerSecond: bigint; // fixed-point, scaled by RATE_SCALE
  total: bigint;
  startTime: bigint;
  salt: Hex;
}

export function encodeTerms(t: StreamTerms): Hex {
  return encodeAbiParameters(TERMS_ABI, [
    t.employer, t.recipient, t.token,
    t.ratePerSecond, t.total, t.startTime, t.salt,
  ]);
}

export function decodeTerms(termsHex: Hex): StreamTerms {
  const [employer, recipient, token, ratePerSecond, total, startTime, salt] =
    decodeAbiParameters(TERMS_ABI, termsHex);
  return {
    employer, recipient, token,
    ratePerSecond, total, startTime: BigInt(startTime), salt,
  };
}

/** The commitment published on-chain. Everything else stays sealed. */
export function commitTo(terms: StreamTerms): Hex {
  return keccak256(encodeTerms(terms));
}

// --- rate fixed-point --------------------------------------------------------

/**
 * `ratePerSecond` is raw token units per second multiplied by RATE_SCALE.
 *
 * FXRP and USDT0 on Coston2 have 6 decimals, so 10 FXRP/day is 115.7407… raw
 * units per second. A plain integer rate truncates to 115 and underpays ~0.64%
 * — unacceptable for payroll. At 1e12 scaling the residual is far below one raw
 * unit over any realistic stream.
 *
 * Lives entirely off-chain: StreamVault never sees a rate, only the resulting
 * cumulativeAccrued. Changing the scale needs no redeploy, but it DOES reinterpret
 * existing sealed terms — cancel those streams, never reinterpret them.
 */
export const RATE_SCALE = 10n ** 12n;

/** tokens/second (decimal string) -> scaled integer for the terms blob. */
export function toScaledRate(rawUnitsPerSecond: string): bigint {
  const [whole, frac = ""] = rawUnitsPerSecond.split(".");
  const fracPadded = (frac + "0".repeat(12)).slice(0, 12);
  return BigInt(whole) * RATE_SCALE + BigInt(fracPadded || "0");
}

/** Convenience: whole tokens per day -> scaled rate. */
export function ratePerDayToScaled(rawUnitsPerDay: bigint): bigint {
  return (rawUnitsPerDay * RATE_SCALE) / 86_400n;
}

/** Deterministic accrual. The same maths the enclave signs and the UI ticks. */
export function accruedAt(
  terms: Pick<StreamTerms, "ratePerSecond" | "total" | "startTime">,
  nowSeconds: bigint,
): bigint {
  const elapsed = nowSeconds > terms.startTime ? nowSeconds - terms.startTime : 0n;
  const accrued = (terms.ratePerSecond * elapsed) / RATE_SCALE;
  return accrued < terms.total ? accrued : terms.total;
}

// --- digests -----------------------------------------------------------------

/** What the TEE signs and StreamVault verifies via ecrecover. */
export function buildAuthDigest(params: {
  tag: Hex;
  chainId: bigint;
  vault: Hex;
  streamId: bigint;
  commitment: Hex;
  cumulativeAccrued: bigint;
  deadline: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" },
        { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
      ],
      [
        params.tag, params.chainId, params.vault, params.streamId,
        params.commitment.toLowerCase() as Hex,
        params.cumulativeAccrued, params.deadline,
      ],
    ),
  );
}

/**
 * What a caller signs to prove they are a party to the stream.
 *
 * Without this, confidentiality is theatre: commitment and ciphertext are both
 * public (emitted in StreamCreated), so anyone could poll the enclave and diff
 * cumulativeAccrued to derive the salary. `issuedAt` bounds replay.
 */
export function buildCallerChallenge(params: {
  chainId: bigint;
  vault: Hex;
  streamId: bigint;
  commitment: Hex;
  purpose: Hex; // WITHDRAW_TAG | SETTLE_TAG
  issuedAt: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" },
        { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
      ],
      [
        CALLER_AUTH_TAG, params.chainId, params.vault, params.streamId,
        params.commitment.toLowerCase() as Hex,
        params.purpose, params.issuedAt,
      ],
    ),
  );
}
