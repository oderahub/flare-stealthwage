/**
 * Spike verifier: proves a ciphertext produced IN THE BROWSER decrypts with the
 * enclave key and round-trips to the same commitment.
 *
 *   npm run verify-ct -- <ciphertextHex> <expectedCommitment>
 *
 * "It builds" is not the bar. A browser bundle can encrypt with subtly
 * different byte handling (Buffer shims, UTF-8 vs raw) and produce ciphertext
 * the enclave rejects — or worse, plaintext that hashes to a different
 * commitment, which would surface on-chain as "terms do not match commitment"
 * long after the UI looked fine.
 */
import { PrivateKey, decrypt } from "eciesjs";
import { decodeAbiParameters, keccak256 } from "viem";

import { TERMS_ABI } from "../src/app/streamHandlers.js";

const [ciphertextHex, expectedCommitment] = process.argv.slice(2);

if (!ciphertextHex) {
  console.error("usage: npm run verify-ct -- <ciphertextHex> [expectedCommitment]");
  process.exit(1);
}

const eciesPriv = process.env.TEE_ECIES_PRIVKEY;
if (!eciesPriv) {
  console.error("TEE_ECIES_PRIVKEY not set (source .env)");
  process.exit(1);
}

const clean = ciphertextHex.startsWith("0x") ? ciphertextHex.slice(2) : ciphertextHex;

let plaintext: Uint8Array;
try {
  plaintext = decrypt(eciesPriv, Buffer.from(clean, "hex"));
} catch (e) {
  console.error("DECRYPT FAILED —", e instanceof Error ? e.message : e);
  console.error("The browser produced ciphertext the enclave cannot open.");
  process.exit(1);
}

// eciesjs >= 0.5 returns Uint8Array, not Buffer. Uint8Array.toString("hex")
// silently ignores the argument and yields "0,0,11,165,…" — wrap it first.
const termsHex = `0x${Buffer.from(plaintext).toString("hex")}` as `0x${string}`;
const commitment = keccak256(termsHex);

console.log("decrypted OK");
console.log("  bytes      :", plaintext.length);
console.log("  commitment :", commitment);

try {
  const [employer, recipient, token, rate, total, startTime, salt] =
    decodeAbiParameters(TERMS_ABI, termsHex);
  console.log("  employer   :", employer);
  console.log("  recipient  :", recipient);
  console.log("  token      :", token);
  console.log("  rate       :", rate.toString());
  console.log("  total      :", total.toString());
  console.log("  startTime  :", startTime.toString());
  console.log("  salt       :", salt);
} catch (e) {
  console.error("DECODE FAILED — decrypted bytes are not valid terms:", e);
  process.exit(1);
}

if (expectedCommitment) {
  const match = commitment.toLowerCase() === expectedCommitment.toLowerCase();
  console.log(`  expected   : ${expectedCommitment}`);
  console.log(match ? "\nROUND-TRIP OK" : "\nCOMMITMENT MISMATCH");
  process.exit(match ? 0 : 1);
}
