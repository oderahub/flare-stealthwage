/**
 * Read-only chain access for the landing and verify pages.
 *
 * No wagmi, no wallet: these routes must work for a judge arriving cold with no
 * extension installed, and they must survive the FCC extension tunnel being
 * down. Everything here is a plain RPC read.
 */
import {
  createPublicClient,
  decodeAbiParameters,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 114);
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
export const EXPLORER =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://coston2-explorer.flare.network";
export const VAULT_ADDRESS = (process.env.NEXT_PUBLIC_STREAMVAULT_ADDRESS ??
  "0xd235B90dc929f7B061EAefdE0C8f020B3Cff47D7") as Hex;
export const DEMO_STREAM_ID = BigInt(process.env.NEXT_PUBLIC_DEMO_STREAM_ID ?? "3");
/**
 * Block of the demo stream's revealTerms tx.
 *
 * Defaulted rather than left at 0 so a fresh deploy works with no dashboard
 * configuration: the Coston2 RPC caps getLogs at 30 blocks, so without a
 * correct anchor the revealed-terms lookup silently finds nothing and the
 * landing page's right-hand column reads "terms not revealed".
 */
export const DEMO_REVEAL_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_DEMO_REVEAL_BLOCK ?? "33546811",
);

export const coston2 = defineChain({
  id: CHAIN_ID,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Coston2 Explorer", url: EXPLORER } },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: coston2,
  transport: http(RPC_URL),
});

export const VAULT_ABI = parseAbi([
  "function streams(uint256) view returns (address employer, address recipient, address token, bytes32 commitment, uint128 funded, uint128 withdrawn, uint64 startTime, bool cancelled)",
  "function teeSigner() view returns (address)",
  "event TermsRevealed(uint256 indexed streamId, bytes terms)",
  "event StreamCreated(uint256 indexed streamId, address indexed employer, address indexed recipient, address token, bytes32 commitment, uint64 startTime, bytes encryptedTerms)",
]);

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

export interface OnChainStream {
  employer: Hex;
  recipient: Hex;
  token: Hex;
  commitment: Hex;
  funded: bigint;
  withdrawn: bigint;
  startTime: bigint;
  cancelled: boolean;
}

export async function readStream(streamId: bigint): Promise<OnChainStream> {
  const r = (await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "streams",
    args: [streamId],
  })) as readonly [Hex, Hex, Hex, Hex, bigint, bigint, bigint, boolean];

  return {
    employer: r[0], recipient: r[1], token: r[2], commitment: r[3],
    funded: r[4], withdrawn: r[5], startTime: BigInt(r[6]), cancelled: r[7],
  };
}

/**
 * Fetch revealed plaintext terms, if the employer has published them.
 *
 * Queries a narrow block window around the known reveal block: public RPCs
 * reject wide `getLogs` ranges, so scanning from genesis is not an option.
 */
export async function readRevealedTerms(streamId: bigint): Promise<Hex | null> {
  // The reveal block is known, so query a tight window around it. Two reasons:
  // public RPCs reject wide ranges, and they also reject a `toBlock` past the
  // chain head ("requested to block N after last accepted block M") — so the
  // window must be clamped, not just narrow. A fixed window also keeps this
  // query the same size in three weeks as it is today.
  // HARD LIMIT: the Coston2 public RPC rejects getLogs ranges over 30 blocks
  // ("requested too many blocks ... maximum is set to 30"). Keep the window
  // well inside that. This is why the reveal block is pinned in env rather than
  // discovered by scanning — a wide historical scan is simply not available.
  const head = await publicClient.getBlockNumber();
  const span = 10n;
  const anchor = DEMO_REVEAL_BLOCK > 0n && DEMO_REVEAL_BLOCK <= head ? DEMO_REVEAL_BLOCK : head;
  const fromBlock = anchor > span ? anchor - span : 0n;
  const toBlock = anchor + span > head ? head : anchor + span;

  const logs = await publicClient.getLogs({
    address: VAULT_ADDRESS,
    event: VAULT_ABI[2],
    args: { streamId },
    fromBlock,
    toBlock,
  });

  const last = logs[logs.length - 1];
  return (last?.args?.terms as Hex | undefined) ?? null;
}

export async function readTokenMeta(token: Hex) {
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  return { decimals: Number(decimals), symbol: symbol as string };
}

export const short = (a: string, n = 6) => `${a.slice(0, n + 2)}…${a.slice(-4)}`;

/** keccak256("StreamCreated(uint256,address,address,address,bytes32,uint64,bytes)") */
const STREAM_CREATED_TOPIC =
  "0x53c8067c6ec448936f0de64df8f0359d0a324be1a35dcf3150a229bf13312a28";

/**
 * The sealed ciphertext exists ONLY in the StreamCreated event — the vault
 * stores just the commitment. But the Coston2 RPC caps eth_getLogs at 30
 * blocks, so history cannot be scanned over JSON-RPC.
 *
 * The Blockscout explorer API has no such limit and needs no key, so it serves
 * as the indexer. Verified across a 46k-block range.
 */
const EXPLORER_API = `${EXPLORER}/api`;

interface CreatedLog {
  streamId: bigint;
  employer: Hex;
  recipient: Hex;
  encryptedTerms: Hex;
  blockNumber: number;
}

function decodeCreatedLog(log: {
  topics: string[];
  data: string;
  blockNumber: string;
}): CreatedLog | null {
  try {
    // Non-indexed: (address token, bytes32 commitment, uint64 startTime, bytes encryptedTerms)
    const [, , , encryptedTerms] = decodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }],
      log.data as Hex,
    );
    return {
      streamId: BigInt(log.topics[1]),
      employer: `0x${log.topics[2].slice(26)}` as Hex,
      recipient: `0x${log.topics[3].slice(26)}` as Hex,
      encryptedTerms: encryptedTerms as Hex,
      blockNumber: parseInt(log.blockNumber, 16),
    };
  } catch {
    return null;
  }
}

async function queryCreatedLogs(extraParams: string): Promise<CreatedLog[]> {
  const url =
    `${EXPLORER_API}?module=logs&action=getLogs&fromBlock=1&toBlock=latest` +
    `&address=${VAULT_ADDRESS}&topic0=${STREAM_CREATED_TOPIC}${extraParams}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  const body = (await res.json()) as { status: string; result?: unknown };
  if (body.status !== "1" || !Array.isArray(body.result)) return [];
  return (body.result as Parameters<typeof decodeCreatedLog>[0][])
    .map(decodeCreatedLog)
    .filter((x): x is CreatedLog => x !== null);
}

/** The sealed terms for one stream, needed to ask the enclave anything. */
export async function fetchEncryptedTerms(streamId: bigint): Promise<Hex | null> {
  const logs = await queryCreatedLogs("");
  return logs.find((l) => l.streamId === streamId)?.encryptedTerms ?? null;
}

/** Streams where `who` is the recipient. */
export async function fetchStreamsForRecipient(who: Hex): Promise<CreatedLog[]> {
  const padded = `0x${who.toLowerCase().slice(2).padStart(64, "0")}`;
  return queryCreatedLogs(`&topic3=${padded}&topic0_3_opr=and`);
}
