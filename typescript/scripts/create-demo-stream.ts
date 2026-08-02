/**
 * Creates the long-lived demo stream the landing page reads from.
 *
 *   npm run demo-stream
 *
 * This is INFRASTRUCTURE, not content: it must stay coherent, unattended, for
 * the whole judging window (Aug 15-21) and the winner announcement (Aug 24).
 * Three properties make that true:
 *
 *  1. LOW RATE, not high funding. We hold ~10 USDT0 total, so "fund it
 *     generously" is not a lever. At 0.25/day it accrues ~6 over 24 days and
 *     stays under the funded balance the entire time.
 *  2. HIGH TOTAL. Accrual clamps at `total` independently of the balance; set
 *     it far above anything reachable so the ticker never freezes mid-judging.
 *  3. TERMS REVEALED. The landing page's "what the recipient sees" column reads
 *     plaintext from the TermsRevealed event and verifies keccak256(terms) ==
 *     commitment in the browser. Nothing is hardcoded and no secret is spent —
 *     the terms are published deliberately, which also demos Audit Mode.
 *
 * The recipient key is derived deterministically so the recipient dashboard can
 * later sign caller-auth challenges as "Alice" without new key management.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PrivateKey, encrypt } from "eciesjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commitTo, encodeTerms, ratePerDayToScaled } from "../src/shared/protocol.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 114);
const VAULT = (process.env.STREAMVAULT_ADDRESS ??
  "0xd235B90dc929f7B061EAefdE0C8f020B3Cff47D7") as Hex;
const TOKEN = (process.env.DEMO_TOKEN_ADDRESS ??
  "0xc1a5b41512496b80903d1f32d6dea3a73212e71f") as Hex; // USDT0

/** Deterministic demo recipient — "Alice". Key is reproducible, not secret. */
const DEMO_RECIPIENT_KEY = keccak256(toBytes("stealthwage-demo-alice-v1"));

const PER_DAY_WHOLE = "0.25"; // tokens/day — deliberately small, see header
const FUND_WHOLE = 8n; // of ~10 available
const TOTAL_WHOLE = 100n; // far above anything reachable; prevents freeze
const BACKDATE_DAYS = 3n; // so the panel shows a live figure immediately

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
  return JSON.parse(
    readFileSync(join(ROOT, "out", "StreamVault.sol", "StreamVault.json"), "utf-8"),
  ).abi;
}

function must(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAILED: ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const deployKey = process.env.DEPLOYMENT_PRIVATE_KEY as Hex | undefined;
  const eciesPriv = process.env.TEE_ECIES_PRIVKEY;
  must(!!deployKey, "DEPLOYMENT_PRIVATE_KEY not set (source .env)");
  must(!!eciesPriv, "TEE_ECIES_PRIVKEY not set (run: npm run tee-keys)");

  const employer = privateKeyToAccount(deployKey!);
  const recipient = privateKeyToAccount(DEMO_RECIPIENT_KEY).address;

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account: employer, chain: coston2, transport: http(RPC) });
  const abi = vaultAbi();

  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: "decimals" }),
    publicClient.readContract({ address: TOKEN, abi: ERC20, functionName: "symbol" }),
  ]);
  const unit = 10n ** BigInt(decimals);

  const fundAmount = FUND_WHOLE * unit;
  const balance = (await publicClient.readContract({
    address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [employer.address],
  })) as bigint;
  must(
    balance >= fundAmount,
    `need ${formatUnits(fundAmount, decimals)} ${symbol}, have ${formatUnits(balance, decimals)}`,
  );

  const perDayRaw = BigInt(Math.round(Number(PER_DAY_WHOLE) * Number(unit)));
  const rate = ratePerDayToScaled(perDayRaw);
  const startTime =
    BigInt(Math.floor(Date.now() / 1000)) - BACKDATE_DAYS * 86_400n;

  const terms = {
    employer: employer.address as Hex,
    recipient: recipient as Hex,
    token: TOKEN,
    ratePerSecond: rate,
    total: TOTAL_WHOLE * unit,
    startTime,
    salt: keccak256(toBytes(`stealthwage-demo-${Date.now()}`)),
  };
  const termsHex = encodeTerms(terms);
  const commitment = commitTo(terms);
  const encryptedTerms = `0x${Buffer.from(
    encrypt(PrivateKey.fromHex(eciesPriv!).publicKey.toHex(), Buffer.from(termsHex.slice(2), "hex")),
  ).toString("hex")}` as Hex;

  console.log("Creating demo stream");
  console.log(`  token      ${symbol} ${TOKEN}`);
  console.log(`  rate       ${PER_DAY_WHOLE} ${symbol}/day`);
  console.log(`  funded     ${formatUnits(fundAmount, decimals)} ${symbol}`);
  console.log(`  total cap  ${TOTAL_WHOLE} ${symbol}`);
  console.log(`  recipient  ${recipient}`);
  console.log(`  backdated  ${BACKDATE_DAYS} days`);

  // 1. create
  const createHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "createStream",
    args: [recipient, TOKEN, commitment, startTime, encryptedTerms],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  must(rcpt.status === "success", "createStream reverted");

  let streamId = 0n;
  for (const log of rcpt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "StreamCreated") streamId = (ev.args as { streamId: bigint }).streamId;
    } catch { /* not ours */ }
  }
  must(streamId > 0n, "StreamCreated not found");
  console.log(`\n  created streamId ${streamId}  ${createHash}`);

  // 2. fund
  const approveHash = await wallet.writeContract({
    address: TOKEN, abi: ERC20, functionName: "approve", args: [VAULT, fundAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  const fundHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "fund", args: [streamId, fundAmount],
  });
  must(
    (await publicClient.waitForTransactionReceipt({ hash: fundHash })).status === "success",
    "fund reverted",
  );
  console.log(`  funded            ${fundHash}`);

  // 3. reveal — deliberate, so the landing page can show verifiable plaintext
  const revealHash = await wallet.writeContract({
    address: VAULT, abi, functionName: "revealTerms", args: [streamId, termsHex],
  });
  must(
    (await publicClient.waitForTransactionReceipt({ hash: revealHash })).status === "success",
    "revealTerms reverted",
  );
  console.log(`  revealed          ${revealHash}`);

  console.log("\nAdd to frontend/.env.local:");
  console.log(`NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID}`);
  console.log(`NEXT_PUBLIC_RPC_URL=${RPC}`);
  console.log(`NEXT_PUBLIC_STREAMVAULT_ADDRESS=${VAULT}`);
  console.log(`NEXT_PUBLIC_DEMO_STREAM_ID=${streamId}`);
  console.log(`NEXT_PUBLIC_DEMO_TOKEN_ADDRESS=${TOKEN}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
