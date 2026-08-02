/**
 * StealthWage end-to-end proof against live Coston2.
 *
 *   npm run e2e
 *
 * Walks the entire demo spine and asserts each step on-chain:
 *
 *   1. Employer builds stream terms and ECIES-encrypts them to the TEE pubkey.
 *   2. createStream() stores ONLY keccak256(terms). The explorer sees a hash.
 *   3. fund() moves real FXRP into the vault.
 *   4. The FCC extension is called over HTTP with the exact tee-node envelope;
 *      it decrypts, verifies the commitment, computes accrual, and signs.
 *   5. withdraw() verifies that signature via ecrecover and pays the recipient.
 *   6. revealTerms() proves Audit Mode: the plaintext matches the commitment.
 *
 * Deliberately uses the DIRECT path (HTTP straight to the extension) rather
 * than on-chain instruction routing: the digest binds the commitment, so the
 * enclave needs no chain reads, no indexer, and no registered TEE machine.
 * That is what makes this runnable while FCC's routing layer is unreliable.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PrivateKey, encrypt } from "eciesjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/app/config.js";
import { register, reportState } from "../src/app/handlers.js";
import {
  RATE_SCALE,
  TERMS_ABI,
  WITHDRAW_TAG,
  buildCallerChallenge,
  toScaledRate,
} from "../src/app/streamHandlers.js";
import { Server } from "../src/base/server.js";
import { bytesToHex, stringToBytes32Hex } from "../src/base/encoding.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- config -----------------------------------------------------------------
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 114);
const VAULT = (process.env.STREAMVAULT_ADDRESS ??
  "0xd235B90dc929f7B061EAefdE0C8f020B3Cff47D7") as Hex;
const TOKEN = (process.env.FXRP_ADDRESS ??
  "0x0b6a3645c240605887a5532109323a3e12273dc7") as Hex;
const EXT_PORT = 18080;

const coston2 = defineChain({
  id: CHAIN_ID,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function vaultAbi() {
  const artifact = JSON.parse(
    readFileSync(join(ROOT, "out", "StreamVault.sol", "StreamVault.json"), "utf-8"),
  );
  return artifact.abi;
}

const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);
const ok = (s: string) => console.log(`    OK  ${s}`);

function must(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`\nFAILED: ${msg}`);
    process.exit(1);
  }
}

/** POST /action body in the exact shape tee-node sends. */
function buildActionBody(opType: string, opCommand: string, payload: unknown): string {
  const original = Buffer.from(JSON.stringify(payload), "utf-8");
  const actionId = `0x${"11".repeat(32)}`;
  const dataFixed = {
    instructionId: actionId,
    teeId: `0x${"22".repeat(20)}`,
    timestamp: Math.floor(Date.now() / 1000),
    rewardEpochId: 0,
    opType: stringToBytes32Hex(opType),
    opCommand: stringToBytes32Hex(opCommand),
    cosigners: [],
    cosignersThreshold: 0,
    originalMessage: bytesToHex(new Uint8Array(original)),
    additionalFixedMessage: "0x",
  };
  return JSON.stringify({
    data: {
      id: actionId,
      type: "instruction",
      submissionTag: "submit",
      message: bytesToHex(Buffer.from(JSON.stringify(dataFixed), "utf-8")),
    },
    additionalVariableMessages: [],
    timestamps: [],
    additionalActionData: "0x",
    signatures: [],
  });
}

async function main() {
  const deployKey = process.env.DEPLOYMENT_PRIVATE_KEY as Hex | undefined;
  const eciesPriv = process.env.TEE_ECIES_PRIVKEY;
  must(!!deployKey, "DEPLOYMENT_PRIVATE_KEY not set (source .env)");
  must(!!eciesPriv, "TEE_ECIES_PRIVKEY not set (run: npm run tee-keys)");

  const employer = privateKeyToAccount(deployKey!);
  const recipient = privateKeyToAccount(generatePrivateKey()).address; // fresh: starts at 0

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account: employer, chain: coston2, transport: http(RPC) });
  const abi = vaultAbi();

  console.log("StealthWage e2e — live Coston2");
  console.log(`  vault     ${VAULT}`);
  console.log(`  employer  ${employer.address}`);
  console.log(`  recipient ${recipient}`);

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: "decimals" }),
    publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: "symbol" }),
  ]);
  console.log(`  token     ${symbol} (${decimals} decimals) ${TOKEN}`);

  // --- 1. encrypt the terms -------------------------------------------------
  step(1, "Employer encrypts stream terms to the TEE public key");
  const perDay = 10n * 10n ** BigInt(decimals); // 10 tokens/day
  const rate = toScaledRate((Number(perDay) / 86_400).toFixed(12));
  const total = perDay * 30n;
  const fundAmount = 5n * 10n ** BigInt(decimals);
  // Backdated one hour so there is accrual to withdraw immediately.
  const startTime = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
  const salt = keccak256(toBytes(`salt-${Date.now()}-${Math.random()}`));

  const terms = encodeAbiParameters(TERMS_ABI, [
    employer.address, recipient, TOKEN, rate, total, startTime, salt,
  ]);
  const commitment = keccak256(terms);
  const eciesPub = PrivateKey.fromHex(eciesPriv!).publicKey.toHex();
  const encryptedTerms = bytesToHex(
    encrypt(eciesPub, Buffer.from(terms.slice(2), "hex")),
  ) as Hex;
  ok(`rate 10 ${symbol}/day, commitment ${commitment.slice(0, 18)}…`);
  ok(`terms encrypted (${(encryptedTerms.length - 2) / 2} bytes ciphertext)`);

  // --- 2. createStream ------------------------------------------------------
  step(2, "createStream() — chain stores only the commitment");
  const createHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "createStream",
    args: [recipient, TOKEN, commitment, startTime, encryptedTerms],
  });
  const createRcpt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  must(createRcpt.status === "success", `createStream reverted (${createHash})`);

  let streamId = 0n;
  for (const log of createRcpt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "StreamCreated") {
        streamId = (ev.args as { streamId: bigint }).streamId;
      }
    } catch { /* not our event */ }
  }
  must(streamId > 0n, "StreamCreated event not found");
  ok(`streamId ${streamId}  tx ${createHash}`);

  const stored = (await publicClient.readContract({
    address: VAULT, abi, functionName: "streams", args: [streamId],
  })) as unknown[];
  must(String(stored[3]).toLowerCase() === commitment.toLowerCase(),
    "on-chain commitment mismatch");
  ok("on-chain state holds the commitment — rate and total are NOT on chain");

  // --- 3. fund --------------------------------------------------------------
  step(3, `fund() — moving ${formatUnits(fundAmount, decimals)} ${symbol} into the vault`);
  const approveHash = await wallet.writeContract({
    address: TOKEN, abi: ERC20, functionName: "approve", args: [VAULT, fundAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  const fundHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "fund", args: [streamId, fundAmount],
  });
  const fundRcpt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
  must(fundRcpt.status === "success", "fund reverted");
  ok(`funded  tx ${fundHash}`);

  // --- 4. ask the enclave for an authorization ------------------------------
  step(4, "Caller auth + FCC extension: decrypt → verify commitment → accrue → sign");
  // The employer signs the challenge. A stranger holding only the public
  // commitment and ciphertext is refused — see the caller-auth tests.
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const callerSignature = await employer.signMessage({
    message: {
      raw: buildCallerChallenge({
        chainId: BigInt(CHAIN_ID), vault: VAULT, streamId,
        commitment, purpose: WITHDRAW_TAG, issuedAt,
      }),
    },
  });
  ok(`challenge signed by employer ${employer.address.slice(0, 10)}…`);

  const server = new Server(EXT_PORT, EXT_PORT + 1, VERSION, register, reportState);
  await server.listenAndServe();

  let auth: { cumulativeAccrued: string; deadline: string; signature: Hex };
  try {
    const res = await fetch(`http://127.0.0.1:${EXT_PORT}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: buildActionBody("STREAM", "AUTH_WITHDRAW", {
        streamId: streamId.toString(),
        vault: VAULT,
        chainId: String(CHAIN_ID),
        commitment,
        encryptedTerms,
        issuedAt: issuedAt.toString(),
        callerSignature,
      }),
    });
    const body = (await res.json()) as { status: number; data: Hex; errorMessage?: string };
    must(res.ok, `extension HTTP ${res.status}`);
    must(body.status === 1, `extension returned error: ${body.errorMessage ?? "unknown"}`);
    auth = JSON.parse(Buffer.from(body.data.slice(2), "hex").toString("utf-8"));
  } finally {
    await server.close();
  }
  const accrued = BigInt(auth.cumulativeAccrued);
  ok(`authorized ${formatUnits(accrued, decimals)} ${symbol} (~1h of a 10/day stream)`);
  ok(`signature ${auth.signature.slice(0, 20)}…`);

  // --- 5. withdraw ----------------------------------------------------------
  step(5, "withdraw() — vault verifies the TEE signature via ecrecover");
  const before = (await publicClient.readContract({
    address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [recipient],
  })) as bigint;
  must(before === 0n, "fresh recipient should start at zero");

  const wHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "withdraw",
    args: [streamId, accrued, BigInt(auth.deadline), auth.signature],
  });
  const wRcpt = await publicClient.waitForTransactionReceipt({ hash: wHash });
  must(wRcpt.status === "success", `withdraw reverted (${wHash})`);

  const after = (await publicClient.readContract({
    address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [recipient],
  })) as bigint;
  must(after === accrued, `expected ${accrued} got ${after}`);
  ok(`recipient received ${formatUnits(after, decimals)} ${symbol}  tx ${wHash}`);

  // --- 6. Audit Mode --------------------------------------------------------
  step(6, "revealTerms() — Audit Mode proves the plaintext matches the commitment");
  const revealHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "revealTerms", args: [streamId, terms],
  });
  const revealRcpt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
  must(revealRcpt.status === "success", "revealTerms reverted");
  ok(`revealed and verified on-chain  tx ${revealHash}`);

  console.log("\n=== END-TO-END PASSED on Coston2 ===");
  console.log(`stream ${streamId}: ${formatUnits(after, decimals)} ${symbol} paid confidentially`);
  console.log(`explorer: https://coston2-explorer.flare.network/tx/${wHash}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
