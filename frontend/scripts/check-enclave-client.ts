/**
 * Exercises the FRONTEND's own enclave client against a running extension.
 *
 *   npx tsx scripts/check-enclave-client.ts
 *
 * Why this exists: `buildActionBody` is implemented twice — once in
 * typescript/scripts/e2e-coston2.ts (which passes against Coston2 using the
 * scaffold's own encoding helpers) and once in frontend/lib/enclave.ts (which
 * uses hand-rolled Uint8Array helpers, because the browser bundle must not pull
 * in Node APIs).
 *
 * Those two must produce byte-identical envelopes. Nothing proved that until
 * now: the e2e never touches the frontend's copy, so a divergence would surface
 * only when a human clicked "Sign to unlock" with MetaMask open.
 *
 * This drives the real client, with a real challenge signature, against a real
 * enclave. No wallet needed — the demo recipient's key is derived from a fixed
 * seed, the same one create-demo-stream.ts uses.
 */
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { WITHDRAW_TAG, buildCallerChallenge, decodeTerms } from "@protocol";
import {
  CHAIN_ID,
  DEMO_STREAM_ID,
  VAULT_ADDRESS,
  fetchEncryptedTerms,
  readStream,
} from "../lib/chain";
import { ENCLAVE_URL, requestAuthorization } from "../lib/enclave";

const DEMO_RECIPIENT_KEY = keccak256(toBytes("stealthwage-demo-alice-v1"));

function fail(msg: string): never {
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  const alice = privateKeyToAccount(DEMO_RECIPIENT_KEY);
  console.log("frontend enclave-client check");
  console.log(`  enclave   ${ENCLAVE_URL}`);
  console.log(`  stream    #${DEMO_STREAM_ID}`);
  console.log(`  signer    ${alice.address} (demo recipient)`);

  const stream = await readStream(DEMO_STREAM_ID);
  if (stream.recipient.toLowerCase() !== alice.address.toLowerCase()) {
    fail(
      `demo recipient mismatch: chain says ${stream.recipient}, derived ${alice.address}`,
    );
  }
  console.log("  recipient matches the on-chain stream ✓");

  const sealed = await fetchEncryptedTerms(DEMO_STREAM_ID);
  if (!sealed) fail("could not fetch sealed terms from the explorer API");
  console.log(`  sealed terms ${(sealed!.length - 2) / 2} bytes (explorer API) ✓`);

  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const challenge = buildCallerChallenge({
    chainId: BigInt(CHAIN_ID),
    vault: VAULT_ADDRESS,
    streamId: DEMO_STREAM_ID,
    commitment: stream.commitment,
    purpose: WITHDRAW_TAG,
    issuedAt,
  });
  const callerSignature = await alice.signMessage({ message: { raw: challenge } });

  console.log("\n  calling the enclave through frontend/lib/enclave.ts…");
  const res = await requestAuthorization({
    streamId: DEMO_STREAM_ID.toString(),
    vault: VAULT_ADDRESS,
    chainId: String(CHAIN_ID),
    commitment: stream.commitment,
    encryptedTerms: sealed as Hex,
    issuedAt: issuedAt.toString(),
    callerSignature,
    command: "AUTH_WITHDRAW",
  });

  if (!res.ok) {
    fail(
      `${res.error.kind}: ${res.error.detail}` +
        (res.error.kind === "unreachable"
          ? `\n  (is the extension running?  cd typescript && npm run serve)`
          : ""),
    );
  }

  const { auth } = res;
  console.log("  enclave accepted the frontend's envelope ✓");
  console.log(`  cumulativeAccrued ${auth.cumulativeAccrued}`);
  console.log(`  signature         ${auth.signature.slice(0, 22)}…`);

  if (keccak256(auth.terms).toLowerCase() !== stream.commitment.toLowerCase()) {
    fail("returned terms do not hash to the on-chain commitment");
  }
  console.log("  returned terms hash to the on-chain commitment ✓");

  const terms = decodeTerms(auth.terms);
  console.log(`  decoded rate      ${terms.ratePerSecond} (1e12 fixed-point)`);

  // A stranger must be refused — the property caller-auth exists for.
  const stranger = privateKeyToAccount(keccak256(toBytes("not-a-party")));
  const strangerSig = await stranger.signMessage({
    message: {
      raw: buildCallerChallenge({
        chainId: BigInt(CHAIN_ID),
        vault: VAULT_ADDRESS,
        streamId: DEMO_STREAM_ID,
        commitment: stream.commitment,
        purpose: WITHDRAW_TAG,
        issuedAt,
      }),
    },
  });
  const denied = await requestAuthorization({
    streamId: DEMO_STREAM_ID.toString(),
    vault: VAULT_ADDRESS,
    chainId: String(CHAIN_ID),
    commitment: stream.commitment,
    encryptedTerms: sealed as Hex,
    issuedAt: issuedAt.toString(),
    callerSignature: strangerSig,
    command: "AUTH_WITHDRAW",
  });

  if (denied.ok) fail("a stranger was authorized — caller-auth is broken");
  console.log(`  stranger refused: "${denied.error.detail}" ✓`);

  console.log("\n=== frontend enclave client VERIFIED ===");
  console.log("The envelope frontend/lib/enclave.ts builds is accepted by the");
  console.log("real extension. The MetaMask path now differs only by where the");
  console.log("signature comes from.");
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
