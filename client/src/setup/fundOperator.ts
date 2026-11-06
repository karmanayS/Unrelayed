// S1 task 2: ONE plain legacy transfer from the published genesis key to our operator key (BUILD-PLAN §0.4).
// Refuses to run if the operator already holds funds, so the genesis key is never used twice by accident.
import { privateKeyToAccount } from "viem/accounts";
import { parseEther, type Hex } from "viem";
import { explorerTx, GENESIS_ADDRESS } from "../config.js";
import { operatorKey, requireEnv } from "../lib/env.js";
import { sendLegacyAndWait } from "../lib/legacy.js";
import { getBalance } from "../lib/rpc.js";

const amount = parseEther(process.env.FUND_ETH ?? "5");
const operator = privateKeyToAccount(operatorKey()).address;
const genesisKey = requireEnv("GENESIS_PRIVATE_KEY") as Hex;
if (privateKeyToAccount(genesisKey).address !== GENESIS_ADDRESS) throw new Error("GENESIS_PRIVATE_KEY does not match the published genesis address");

const before = await getBalance(operator);
if (before > 0n) {
  console.log(`operator ${operator} already holds ${Number(before) / 1e18} ETH; not funding again`);
  process.exit(0);
}
console.log(`funding operator ${operator} with ${Number(amount) / 1e18} ETH from genesis ${GENESIS_ADDRESS}…`);
// A transfer to a brand-new account costs 21,000 + 183,600 state gas on this devnet.
const { hash, receipt } = await sendLegacyAndWait(genesisKey, { to: operator, value: amount, gas: 250_000n });
const after = await getBalance(operator);
console.log(`tx ${hash} mined in block ${BigInt(receipt.blockNumber)}, gasUsed ${BigInt(receipt.gasUsed)}`);
console.log(`explorer: ${explorerTx(hash)}`);
console.log(`T1.1 operator balance ${Number(after) / 1e18} ETH (expected ${Number(amount) / 1e18}): ${after === amount ? "PASS" : "FAIL"}`);
process.exit(after === amount ? 0 : 1);
