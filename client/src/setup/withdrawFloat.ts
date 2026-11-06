// Owner-only: moves a TornadoExit instance's whole ETH balance back to the operator (withdrawFunds).
import { encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { operatorKey } from "../lib/env.js";
import { exitAbi } from "../lib/exit.js";
import { sendLegacyAndWait } from "../lib/legacy.js";
import { getBalance } from "../lib/rpc.js";

const exit = process.argv[2] as Address;
if (!exit) throw new Error("usage: withdrawFloat.ts <TornadoExit address>");
const key = operatorKey();
const to = privateKeyToAccount(key).address;
const bal = await getBalance(exit);
const { hash } = await sendLegacyAndWait(key, { to: exit, gas: 200_000n, data: encodeFunctionData({ abi: exitAbi, functionName: "withdrawFunds", args: [to, bal] }) });
console.log(`withdrawFunds(${to}, ${bal}) on ${exit}: tx ${hash}; balance now ${await getBalance(exit)}`);
