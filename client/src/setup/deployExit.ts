// S5 task 2: deploy TornadoExit with an initial ETH float, then stake it (0.012 ETH, 86400 s) via its owner-only
// stake(). `--unstaked` deploys a second instance without staking (T5.5).
import { encodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, STAKE } from "../config.js";
import { EXIT } from "../deployments.js";
import { registryAbi } from "../lib/abis.js";
import { deploy } from "../lib/deploy.js";
import { operatorKey } from "../lib/env.js";
import { exitAbi, MIN_WITHDRAW_EXEC_GAS, MIN_WITHDRAW_STATE_GAS } from "../lib/exit.js";
import { sendLegacyAndWait } from "../lib/legacy.js";
import { client, getBalance } from "../lib/rpc.js";

const unstaked = process.argv.includes("--unstaked");
const float = parseEther(process.env.EXIT_FLOAT_ETH ?? (unstaked ? "0.05" : "0.3"));
const key = operatorKey();
const owner = privateKeyToAccount(key).address;
const args = [ADDR.TORNADO_POOL, EXIT.verifier, ADDR.STAKING_REGISTRY, MIN_WITHDRAW_EXEC_GAS, MIN_WITHDRAW_STATE_GAS, owner];
const d = await deploy(key, "TornadoExit", args, float);
console.log(`TornadoExit${unstaked ? " (unstaked)" : ""} deployed at ${d.address}`);
console.log(`  deploy tx ${d.hash} (gasUsed ${BigInt(d.receipt.gasUsed)}), float ${Number(float) / 1e18} ETH, balance ${await getBalance(d.address)}`);
console.log(`  constructor: TORNADO ${args[0]}, VERIFIER ${args[1]}, REGISTRY ${args[2]}, MIN_EXEC ${args[3]}, MIN_STATE ${args[4]}, owner ${owner}`);
if (!unstaked) {
  const { hash } = await sendLegacyAndWait(key, { to: d.address, value: STAKE.amount, gas: 500_000n, data: encodeFunctionData({ abi: exitAbi, functionName: "stake", args: [] }) });
  const info = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [d.address] });
  console.log(`  stake tx ${hash}: getDepositInfo = stake ${info[0]}, delay ${info[1]}, withdrawTime ${info[2]}`);
}
