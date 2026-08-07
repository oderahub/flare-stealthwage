/**
 * Exercises AUTH_SETTLE / cancelStream end-to-end on live Coston2.
 *
 *   npm run test-settle        (needs: npm run serve, in another terminal)
 *
 * This is the last contract path with Foundry coverage but no live proof.
 *
 * Deliberately built to be SOLVENT and RECOVERABLE, unlike the earlier e2e
 * streams:
 *
 *  - low rate (0.1/day) against generous funding, so accrued stays far below
 *    funded and cancellation actually refunds. A stream that has over-accrued
 *    settles everything to the recipient and refunds nothing — correct
 *    behaviour, but useless as a reclaim test.
 *  - recipient is the DETERMINISTIC demo address, whose key derives from a
 *    fixed seed. The e2e uses a random throwaway, so anything paid to it is
 *    burned. Here the small accrued amount stays recoverable.
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

import {
  SETTLE_TAG,
  buildCallerChallenge,
  commitTo,
  encodeTerms,
  ratePerDayToScaled,
} from "../src/shared/protocol.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 114);
const VAULT = (process.env.STREAMVAULT_ADDRESS ??
  "0xd235B90dc929f7B061EAefdE0C8f020B3Cff47D7") as Hex;
const FXRP = "0x0b6a3645c240605887a5532109323a3e12273dc7" as Hex;
const ENCLAVE = process.env.ENCLAVE_URL ?? "http://127.0.0.1:18080";
const DEMO_RECIPIENT_KEY = keccak256(toBytes("stealthwage-demo-alice-v1"));

const SETTLE_AFTER_SECONDS = 45;

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
]);

const vaultAbi = () =>
  JSON.parse(readFileSync(join(ROOT, "out", "StreamVault.sol", "StreamVault.json"), "utf-8"))
    .abi;

function must(c: boolean, m: string): asserts c {
  if (!c) {
    console.error(`\nFAILED: ${m}`);
    process.exit(1);
  }
}

const stringToBytes32Hex = (s: string): Hex => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s).slice(0, 32));
  return `0x${Buffer.from(b).toString("hex")}` as Hex;
};

function actionBody(opCommand: string, payload: unknown): string {
  const original = Buffer.from(JSON.stringify(payload), "utf-8");
  const id = `0x${"11".repeat(32)}`;
  const df = {
    instructionId: id,
    teeId: `0x${"22".repeat(20)}`,
    timestamp: Math.floor(Date.now() / 1000),
    rewardEpochId: 0,
    opType: stringToBytes32Hex("STREAM"),
    opCommand: stringToBytes32Hex(opCommand),
    cosigners: [],
    cosignersThreshold: 0,
    originalMessage: `0x${original.toString("hex")}`,
    additionalFixedMessage: "0x",
  };
  return JSON.stringify({
    data: {
      id,
      type: "instruction",
      submissionTag: "submit",
      message: `0x${Buffer.from(JSON.stringify(df), "utf-8").toString("hex")}`,
    },
    additionalVariableMessages: [],
    timestamps: [],
    additionalActionData: "0x",
    signatures: [],
  });
}

async function main() {
  const key = process.env.DEPLOYMENT_PRIVATE_KEY as Hex | undefined;
  const eciesPriv = process.env.TEE_ECIES_PRIVKEY;
  must(!!key, "DEPLOYMENT_PRIVATE_KEY not set (set -a; . ./.env; set +a)");
  must(!!eciesPriv, "TEE_ECIES_PRIVKEY not set");

  const employer = privateKeyToAccount(key!);
  const recipient = privateKeyToAccount(DEMO_RECIPIENT_KEY).address;
  const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
  const wallet = createWalletClient({ account: employer, chain: coston2, transport: http(RPC) });
  const abi = vaultAbi();
  const dec = Number(await pub.readContract({ address: FXRP, abi: ERC20, functionName: "decimals" }));
  const unit = 10n ** BigInt(dec);

  const fund = 1n * unit; // 1 FXRP
  const startTime = BigInt(Math.floor(Date.now() / 1000));
  const terms = {
    employer: employer.address as Hex,
    recipient: recipient as Hex,
    token: FXRP,
    ratePerSecond: ratePerDayToScaled(unit / 10n), // 0.1 FXRP/day
    total: 100n * unit,
    startTime,
    salt: keccak256(toBytes(`settle-test-${Date.now()}`)),
  };
  const termsHex = encodeTerms(terms);
  const commitment = commitTo(terms);
  const sealed = `0x${Buffer.from(
    encrypt(PrivateKey.fromHex(eciesPriv!).publicKey.toHex(), Buffer.from(termsHex.slice(2), "hex")),
  ).toString("hex")}` as Hex;

  console.log("AUTH_SETTLE live test");
  console.log(`  rate      0.1 FXRP/day (solvent: 1 FXRP funds ~10 days)`);
  console.log(`  recipient ${recipient} (deterministic — recoverable)`);

  // 1. create + fund
  const ch = await wallet.writeContract({
    address: VAULT, abi, functionName: "createStream",
    args: [terms.recipient, FXRP, commitment, startTime, sealed],
  });
  const r1 = await pub.waitForTransactionReceipt({ hash: ch });
  must(r1.status === "success", "createStream reverted");
  let streamId = 0n;
  for (const log of r1.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === "StreamCreated") streamId = (ev.args as { streamId: bigint }).streamId;
    } catch {}
  }
  must(streamId > 0n, "StreamCreated not found");
  console.log(`\n  [1] created stream #${streamId}  ${ch}`);

  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: FXRP, abi: ERC20, functionName: "approve", args: [VAULT, fund],
    }),
  });
  const fh = await wallet.writeContract({
    address: VAULT, abi, functionName: "fund", args: [streamId, fund],
  });
  must((await pub.waitForTransactionReceipt({ hash: fh })).status === "success", "fund reverted");
  console.log(`  [2] funded 1 FXRP  ${fh}`);

  const empBefore = (await pub.readContract({
    address: FXRP, abi: ERC20, functionName: "balanceOf", args: [employer.address],
  })) as bigint;
  const recBefore = (await pub.readContract({
    address: FXRP, abi: ERC20, functionName: "balanceOf", args: [recipient],
  })) as bigint;

  console.log(`\n  [3] letting it accrue ${SETTLE_AFTER_SECONDS}s…`);
  await new Promise((r) => setTimeout(r, SETTLE_AFTER_SECONDS * 1000));

  // 2. ask the enclave to settle — employer only
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const callerSignature = await employer.signMessage({
    message: {
      raw: buildCallerChallenge({
        chainId: BigInt(CHAIN_ID), vault: VAULT, streamId,
        commitment, purpose: SETTLE_TAG, issuedAt,
      }),
    },
  });

  const res = await fetch(`${ENCLAVE}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: actionBody("AUTH_SETTLE", {
      streamId: streamId.toString(), vault: VAULT, chainId: String(CHAIN_ID),
      commitment, encryptedTerms: sealed,
      issuedAt: issuedAt.toString(), callerSignature,
    }),
  }).catch((e) => {
    console.error(`\nenclave unreachable at ${ENCLAVE} — run: cd typescript && npm run serve`);
    throw e;
  });
  const body = (await res.json()) as { status: number; data: Hex; log?: string };
  must(body.status === 1, `enclave refused settle: ${body.log ?? "unknown"}`);
  const auth = JSON.parse(Buffer.from(body.data.slice(2), "hex").toString("utf-8"));
  console.log(`  [4] enclave signed settle for ${auth.cumulativeAccrued} raw`);

  // 3. cancel
  const cx = await wallet.writeContract({
    address: VAULT, abi, functionName: "cancelStream",
    args: [streamId, BigInt(auth.cumulativeAccrued), BigInt(auth.deadline), auth.signature],
  });
  const r3 = await pub.waitForTransactionReceipt({ hash: cx });
  must(r3.status === "success", `cancelStream reverted (${cx})`);
  console.log(`  [5] cancelled  ${cx}`);

  const empAfter = (await pub.readContract({
    address: FXRP, abi: ERC20, functionName: "balanceOf", args: [employer.address],
  })) as bigint;
  const recAfter = (await pub.readContract({
    address: FXRP, abi: ERC20, functionName: "balanceOf", args: [recipient],
  })) as bigint;

  const refunded = empAfter - empBefore;
  const paid = recAfter - recBefore;
  console.log(`\n  refunded to employer : ${refunded} raw (${formatUnits(refunded, dec)} FXRP)`);
  console.log(`  paid to recipient    : ${paid} raw (${formatUnits(paid, dec)} FXRP)`);
  must(refunded + paid === fund, `split does not reconstruct the funded 1 FXRP`);
  must(paid === BigInt(auth.cumulativeAccrued), "recipient payment != enclave-signed accrual");

  const st = (await pub.readContract({
    address: VAULT, abi, functionName: "streams", args: [streamId],
  })) as unknown[];
  must(st[7] === true, "stream not marked cancelled");

  console.log("\n=== AUTH_SETTLE VERIFIED ON COSTON2 ===");
  console.log(`refund + payout reconstruct the funded amount exactly, and the`);
  console.log(`stream is marked cancelled.`);
  console.log(`explorer: https://coston2-explorer.flare.network/tx/${cx}`);
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
