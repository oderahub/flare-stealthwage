/**
 * Client for the FCC extension.
 *
 * This is the ONE part of the app that depends on the enclave being reachable.
 * `/` and `/verify/[id]` deliberately avoid it, so a dead tunnel degrades one
 * screen rather than the product.
 *
 * Failures are typed rather than thrown as opaque strings: a judge hitting this
 * during judging week should see "the enclave is unreachable", not a spinner
 * that never resolves.
 */
import type { Hex } from "viem";

export const ENCLAVE_URL =
  process.env.NEXT_PUBLIC_ENCLAVE_URL ?? "http://127.0.0.1:18080";

export type EnclaveFailure =
  | { kind: "unreachable"; detail: string }
  | { kind: "rejected"; detail: string };

export interface Authorization {
  streamId: string;
  cumulativeAccrued: string;
  deadline: string;
  signature: Hex;
  /** Sign-then-fetch: the caller proved they are a party, so they get the
   *  plaintext back. The recipient cannot decrypt it themselves — the terms
   *  are sealed to the enclave key — so this is how they learn their own rate. */
  terms: Hex;
}

const HEX = "0123456789abcdef";
function toHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out as Hex;
}

/** bytes32-encoded ASCII, matching the scaffold's stringToBytes32Hex. */
function toBytes32Hex(s: string): Hex {
  const bytes = new Uint8Array(32);
  const enc = new TextEncoder().encode(s);
  bytes.set(enc.slice(0, 32));
  return toHex(bytes);
}

/** POST /action body in the exact shape tee-node sends. */
function buildActionBody(opType: string, opCommand: string, payload: unknown): string {
  const original = new TextEncoder().encode(JSON.stringify(payload));
  const actionId = `0x${"11".repeat(32)}`;
  const dataFixed = {
    instructionId: actionId,
    teeId: `0x${"22".repeat(20)}`,
    timestamp: Math.floor(Date.now() / 1000),
    rewardEpochId: 0,
    opType: toBytes32Hex(opType),
    opCommand: toBytes32Hex(opCommand),
    cosigners: [],
    cosignersThreshold: 0,
    originalMessage: toHex(original),
    additionalFixedMessage: "0x",
  };
  return JSON.stringify({
    data: {
      id: actionId,
      type: "instruction",
      submissionTag: "submit",
      message: toHex(new TextEncoder().encode(JSON.stringify(dataFixed))),
    },
    additionalVariableMessages: [],
    timestamps: [],
    additionalActionData: "0x",
    signatures: [],
  });
}

export async function requestAuthorization(req: {
  streamId: string;
  vault: Hex;
  chainId: string;
  commitment: Hex;
  encryptedTerms: Hex;
  issuedAt: string;
  callerSignature: Hex;
  command: "AUTH_WITHDRAW" | "AUTH_SETTLE";
}): Promise<{ ok: true; auth: Authorization } | { ok: false; error: EnclaveFailure }> {
  const { command, ...payload } = req;

  let res: Response;
  try {
    res = await fetch(`${ENCLAVE_URL}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildActionBody("STREAM", command, payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network-level: tunnel down, CORS blocked, DNS gone, timed out.
    return {
      ok: false,
      error: {
        kind: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (!res.ok) {
    return { ok: false, error: { kind: "unreachable", detail: `HTTP ${res.status}` } };
  }

  const body = (await res.json()) as {
    status: number;
    data: Hex;
    /**
     * tee-node's ActionResult carries the failure reason in `log`, formatted as
     * "error: <detail>" (server.ts §4.6). There is no `errorMessage` field —
     * reading one silently swallows the diagnostic and leaves the UI showing a
     * generic refusal instead of "caller is not a party to this stream".
     */
    log?: string;
  };

  if (body.status !== 1) {
    // The enclave answered and said no — a real verdict, not an outage.
    const detail = (body.log ?? "").replace(/^error:\s*/, "");
    return {
      ok: false,
      error: { kind: "rejected", detail: detail || "authorization refused" },
    };
  }

  const json = new TextDecoder().decode(
    Uint8Array.from(body.data.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16))),
  );
  return { ok: true, auth: JSON.parse(json) as Authorization };
}
