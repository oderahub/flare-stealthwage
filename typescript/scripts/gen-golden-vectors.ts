/**
 * Emits golden vectors that pin the StealthWage authorization digest across
 * languages. Run:  npx tsx scripts/gen-golden-vectors.ts
 *
 * The Solidity side (test/StreamVault.t.sol) hardcodes these and asserts it
 * derives the identical digest. If someone changes the abi.encode layout on
 * either side, that test fails loudly instead of surfacing later as an opaque
 * "bad TEE signature" revert against Coston2.
 *
 * Inputs are fixed constants (not the live vault address) so the vector is
 * stable and reviewable. The test separately proves the deployed vault accepts
 * a signature over a digest built the same way at its own real address.
 */
import { privateKeyToAccount } from "viem/accounts";

import {
  SETTLE_TAG,
  WITHDRAW_TAG,
  buildAuthDigest,
} from "../src/app/streamHandlers.js";

// Fixed, meaningless-but-stable test values. Never used on a real network.
const TEST_SIGNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const VAULT = "0x1111111111111111111111111111111111111111" as const;
const CHAIN_ID = 114n; // Coston2
const STREAM_ID = 7n;
const COMMITMENT =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
const CUMULATIVE_ACCRUED = 123456789000000000n;
const DEADLINE = 1893456000n; // 2030-01-01, far future so tests never expire

async function main() {
  const account = privateKeyToAccount(TEST_SIGNER_KEY);

  const out: Record<string, unknown> = {
    signer: account.address,
    vault: VAULT,
    chainId: CHAIN_ID.toString(),
    streamId: STREAM_ID.toString(),
    commitment: COMMITMENT,
    cumulativeAccrued: CUMULATIVE_ACCRUED.toString(),
    deadline: DEADLINE.toString(),
  };

  for (const [name, tag] of [
    ["withdraw", WITHDRAW_TAG],
    ["settle", SETTLE_TAG],
  ] as const) {
    const digest = buildAuthDigest({
      tag,
      chainId: CHAIN_ID,
      vault: VAULT,
      streamId: STREAM_ID,
      commitment: COMMITMENT,
      cumulativeAccrued: CUMULATIVE_ACCRUED,
      deadline: DEADLINE,
    });
    out[`${name}Tag`] = tag;
    out[`${name}Digest`] = digest;
    out[`${name}Signature`] = await account.signMessage({
      message: { raw: digest },
    });
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
