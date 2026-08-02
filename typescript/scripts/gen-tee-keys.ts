/**
 * Generates the simulated-mode TEE keypairs and writes them into .env files.
 *
 *   npm run tee-keys           # generate if absent (idempotent)
 *   npm run tee-keys -- --force  # rotate existing keys
 *
 * Two keys, different jobs:
 *   TEE_ECIES_PRIVKEY  — employers encrypt stream terms TO this key's public
 *                        half. Only the enclave can read the terms.
 *   TEE_SIGNER_PRIVKEY — signs withdrawal authorizations. Its ADDRESS is what
 *                        StreamVault stores as `teeSigner` and checks in
 *                        ecrecover.
 *
 * These exist only because SIMULATED_TEE=true. In real Confidential Space the
 * enclave generates them internally and publishes the public halves at
 * registration, so no private key ever touches the host. Rotating the signer
 * requires calling StreamVault.setTeeSigner() or withdrawals will revert with
 * "bad TEE signature".
 *
 * Private values are written straight to disk and never printed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrivateKey } from "eciesjs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILES = [join(ROOT, ".env"), join(ROOT, ".env.coston2")];
const FORCE = process.argv.includes("--force");

/** Set or replace `KEY=value` in an .env body, preserving everything else. */
function upsert(body: string, key: string, value: string): string {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) return body.replace(re, line);
  return body.trimEnd() + `\n${line}\n`;
}

function hasKey(body: string, key: string): boolean {
  return new RegExp(`^${key}="?.+"?$`, "m").test(body);
}

function main() {
  const existing = existsSync(ENV_FILES[0]) ? readFileSync(ENV_FILES[0], "utf-8") : "";
  const alreadySet =
    hasKey(existing, "TEE_ECIES_PRIVKEY") && hasKey(existing, "TEE_SIGNER_PRIVKEY");

  if (alreadySet && !FORCE) {
    console.log("TEE keys already present; leaving them alone (--force to rotate).");
    // Still surface the public halves so the caller can deploy against them.
    const eciesPriv = existing.match(/^TEE_ECIES_PRIVKEY="?([^"\n]+)"?$/m)![1];
    const signerPriv = existing.match(/^TEE_SIGNER_PRIVKEY="?([^"\n]+)"?$/m)![1];
    report(eciesPriv, signerPriv);
    return;
  }

  const ecies = new PrivateKey();
  const signerPriv = generatePrivateKey();

  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    let body = readFileSync(file, "utf-8");
    body = upsert(body, "TEE_ECIES_PRIVKEY", ecies.toHex());
    body = upsert(body, "TEE_SIGNER_PRIVKEY", signerPriv);
    writeFileSync(file, body);
    console.log(`wrote TEE keys -> ${file.replace(ROOT + "/", "")}`);
  }

  report(ecies.toHex(), signerPriv);
}

/** Prints only public material. */
function report(eciesPriv: string, signerPriv: string) {
  const eciesPub = PrivateKey.fromHex(eciesPriv).publicKey.toHex();
  const signerAddr = privateKeyToAccount(signerPriv as `0x${string}`).address;
  console.log("");
  console.log("TEE_SIGNER_ADDRESS =", signerAddr, " <- StreamVault constructor arg");
  console.log("TEE_ECIES_PUBKEY   =", eciesPub, " <- employers encrypt terms to this");
}

main();
