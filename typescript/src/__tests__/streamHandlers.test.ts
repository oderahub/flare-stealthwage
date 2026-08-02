/**
 * End-to-end round-trip for the StealthWage authorization flow, no chain
 * required: employer encrypts terms → handler authenticates the caller,
 * decrypts, checks the commitment, computes accrual, signs → we recover the
 * signer and re-derive the digest exactly as StreamVault.sol will.
 *
 * TERMS_ABI is imported from the handler rather than redeclared — a second copy
 * is exactly the drift this project keeps getting bitten by.
 */
import { PrivateKey, encrypt } from "eciesjs";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, recoverMessageAddress, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { bytesToHex } from "../base/encoding.js";
import type { Framework, HandlerFunc, HandlerResult } from "../base/types.js";
import {
  OP_COMMAND_AUTH_SETTLE,
  OP_COMMAND_AUTH_WITHDRAW,
  OP_TYPE_STREAM,
  RATE_SCALE,
  SETTLE_TAG,
  TERMS_ABI,
  WITHDRAW_TAG,
  buildCallerChallenge,
  registerStreamHandlers,
  resetStreamState,
  toScaledRate,
} from "../app/streamHandlers.js";

const VAULT = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x3333333333333333333333333333333333333333" as const;
const CHAIN_ID = "114"; // Coston2
const STREAM_ID = 1n;

// Real keys so the parties can actually sign challenges.
const employer = privateKeyToAccount(generatePrivateKey());
const recipient = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const eciesKey = new PrivateKey();
const signerPriv = generatePrivateKey();
const signerAddr = privateKeyToAccount(signerPriv).address;

function collectHandlers(): Map<string, HandlerFunc> {
  const handlers = new Map<string, HandlerFunc>();
  const fake: Framework = {
    handle: (opType: string, opCommand: string, fn: HandlerFunc) => {
      handlers.set(`${opType}/${opCommand}`, fn);
    },
  } as unknown as Framework;
  registerStreamHandlers(fake);
  return handlers;
}

function jsonToWireHex(obj: unknown): string {
  return bytesToHex(Buffer.from(JSON.stringify(obj), "utf-8"));
}

function buildTerms(opts: {
  rate: bigint;
  total: bigint;
  startTime: bigint;
  salt?: string;
}) {
  const terms = encodeAbiParameters(TERMS_ABI, [
    employer.address, recipient.address, TOKEN,
    opts.rate, opts.total, opts.startTime,
    keccak256(toBytes(opts.salt ?? "salt-default")),
  ]);
  const commitment = keccak256(terms);
  const encryptedTerms = bytesToHex(
    encrypt(eciesKey.publicKey.toHex(), Buffer.from(terms.slice(2), "hex")),
  );
  return { terms, commitment, encryptedTerms };
}

/** Build an authenticated request, signed by `signer`. */
async function buildRequest(opts: {
  commitment: `0x${string}`;
  encryptedTerms: string;
  signer?: typeof employer;
  purpose?: `0x${string}`;
  issuedAt?: bigint;
  signature?: `0x${string}`;
}) {
  const issuedAt = opts.issuedAt ?? BigInt(Math.floor(Date.now() / 1000));
  const purpose = opts.purpose ?? WITHDRAW_TAG;
  const signer = opts.signer ?? recipient;

  const challenge = buildCallerChallenge({
    chainId: BigInt(CHAIN_ID),
    vault: VAULT,
    streamId: STREAM_ID,
    commitment: opts.commitment,
    purpose,
    issuedAt,
  });

  return {
    streamId: STREAM_ID.toString(),
    vault: VAULT,
    chainId: CHAIN_ID,
    commitment: opts.commitment,
    encryptedTerms: opts.encryptedTerms,
    issuedAt: issuedAt.toString(),
    callerSignature:
      opts.signature ?? (await signer.signMessage({ message: { raw: challenge } })),
  };
}

const withdrawHandler = () =>
  collectHandlers().get(`${OP_TYPE_STREAM}/${OP_COMMAND_AUTH_WITHDRAW}`)!;
const settleHandler = () =>
  collectHandlers().get(`${OP_TYPE_STREAM}/${OP_COMMAND_AUTH_SETTLE}`)!;

beforeEach(() => {
  resetStreamState();
  process.env.TEE_ECIES_PRIVKEY = eciesKey.toHex();
  process.env.TEE_SIGNER_PRIVKEY = signerPriv;
});

describe("STREAM/AUTH_WITHDRAW", () => {
  it("decrypts, verifies commitment, accrues, and signs a recoverable authorization", async () => {
    const startTime = BigInt(Math.floor(Date.now() / 1000)) - 3600n; // 1h ago
    const ratePerSec = 1_000_000n; // raw token units per second
    const { commitment, encryptedTerms } = buildTerms({
      rate: ratePerSec * RATE_SCALE,
      total: 10n ** 15n,
      startTime,
      salt: "salt-1",
    });

    const [data, status, err] = (await withdrawHandler()(
      jsonToWireHex(await buildRequest({ commitment, encryptedTerms })),
    )) as HandlerResult;

    expect(err).toBeNull();
    expect(status).toBe(1);
    const resp = JSON.parse(Buffer.from(data!.slice(2), "hex").toString("utf-8"));

    const accrued = BigInt(resp.cumulativeAccrued);
    expect(accrued).toBeGreaterThanOrEqual(ratePerSec * 3600n);
    expect(accrued).toBeLessThanOrEqual(ratePerSec * 3610n);

    // Sign-then-fetch: an authenticated party gets the plaintext terms back.
    expect(resp.terms).toBeDefined();
    expect(keccak256(resp.terms)).toBe(commitment);

    // Re-derive the digest exactly as StreamVault.sol does, recover the signer.
    const digest = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "uint256" }, { type: "address" },
          { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
        ],
        [
          WITHDRAW_TAG, BigInt(CHAIN_ID), VAULT, STREAM_ID,
          commitment, accrued, BigInt(resp.deadline),
        ],
      ),
    );
    expect(
      await recoverMessageAddress({ message: { raw: digest }, signature: resp.signature }),
    ).toBe(signerAddr);
  });

  it("streams 6-decimal FXRP without truncation drift", async () => {
    const PER_DAY = 10_000_000n; // 10 FXRP at 6 decimals
    const rate = toScaledRate((Number(PER_DAY) / 86_400).toFixed(12));
    const startTime = BigInt(Math.floor(Date.now() / 1000)) - 86_400n;
    const { commitment, encryptedTerms } = buildTerms({
      rate, total: PER_DAY * 30n, startTime, salt: "salt-fxrp",
    });

    const [data, status, err] = (await withdrawHandler()(
      jsonToWireHex(await buildRequest({ commitment, encryptedTerms })),
    )) as HandlerResult;

    expect(err).toBeNull();
    expect(status).toBe(1);
    const accrued = BigInt(
      JSON.parse(Buffer.from(data!.slice(2), "hex").toString()).cumulativeAccrued,
    );
    const drift = PER_DAY > accrued ? PER_DAY - accrued : accrued - PER_DAY;
    expect(drift).toBeLessThan(2000n);
    expect(accrued).toBeGreaterThan(9_990_000n);
  });

  it("rejects terms that do not match the commitment", async () => {
    const { encryptedTerms } = buildTerms({
      rate: 1n, total: 2n, startTime: 0n, salt: "salt-2",
    });
    const wrongCommitment = keccak256(toBytes("not-the-terms"));

    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment: wrongCommitment, encryptedTerms }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toContain("terms do not match commitment");
  });

  it("rejects garbage ciphertext without leaking crypto internals", async () => {
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({
          commitment: keccak256(toBytes("x")),
          encryptedTerms: "0xdeadbeef",
        }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("failed to decrypt terms");
  });
});

describe("caller authentication", () => {
  const fixture = () =>
    buildTerms({
      rate: 1_000_000n * RATE_SCALE,
      total: 10n ** 15n,
      startTime: BigInt(Math.floor(Date.now() / 1000)) - 3600n,
      salt: "salt-auth",
    });

  /**
   * THE attack this closes: commitment and ciphertext are both public (they are
   * emitted in StreamCreated), so before caller-auth anyone could poll the
   * enclave and diff cumulativeAccrued to derive the salary.
   */
  it("refuses a stranger holding only the public commitment and ciphertext", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, signer: stranger }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("caller is not a party to this stream");
  });

  it("accepts the recipient", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, signer: recipient }),
      ),
    )) as HandlerResult;
    expect(err).toBeNull();
    expect(status).toBe(1);
  });

  it("accepts the employer for withdraw (funds still go to the recipient on-chain)", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, signer: employer }),
      ),
    )) as HandlerResult;
    expect(err).toBeNull();
    expect(status).toBe(1);
  });

  it("rejects a stale challenge, so a captured request cannot sample accrual later", async () => {
    const { commitment, encryptedTerms } = fixture();
    const stale = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, issuedAt: stale }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("caller authorization expired");
  });

  it("rejects a signature that does not cover this challenge", async () => {
    const { commitment, encryptedTerms } = fixture();
    // Valid signature, but issued for a different stream id.
    const wrongChallenge = buildCallerChallenge({
      chainId: BigInt(CHAIN_ID), vault: VAULT, streamId: 999n,
      commitment, purpose: WITHDRAW_TAG,
      issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    });
    const sig = await recipient.signMessage({ message: { raw: wrongChallenge } });

    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, signature: sig }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("caller is not a party to this stream");
  });

  it("rejects malformed signatures", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await withdrawHandler()(
      jsonToWireHex(
        await buildRequest({ commitment, encryptedTerms, signature: "0x1234" }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("malformed caller signature");
  });
});

describe("STREAM/AUTH_SETTLE", () => {
  const fixture = () =>
    buildTerms({
      rate: 1_000_000n * RATE_SCALE,
      total: 10n ** 15n,
      startTime: BigInt(Math.floor(Date.now() / 1000)) - 3600n,
      salt: "salt-settle",
    });

  it("accepts the employer", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await settleHandler()(
      jsonToWireHex(
        await buildRequest({
          commitment, encryptedTerms, signer: employer, purpose: SETTLE_TAG,
        }),
      ),
    )) as HandlerResult;
    expect(err).toBeNull();
    expect(status).toBe(1);
  });

  /** cancelStream is employer-only on-chain; the enclave must mirror that. */
  it("refuses the recipient, mirroring cancelStream's msg.sender check", async () => {
    const { commitment, encryptedTerms } = fixture();
    const [, status, err] = (await settleHandler()(
      jsonToWireHex(
        await buildRequest({
          commitment, encryptedTerms, signer: recipient, purpose: SETTLE_TAG,
        }),
      ),
    )) as HandlerResult;

    expect(status).toBe(0);
    expect(err).toBe("caller is not a party to this stream");
  });
});
