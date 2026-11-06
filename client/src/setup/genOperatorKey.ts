// S1 task 1: generate the operator key into .env (never overwrites an existing one).
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendEnv, ENV_FILE } from "../lib/env.js";

if (process.env.OPERATOR_PRIVATE_KEY) {
  console.log(`operator key already present in ${ENV_FILE}: ${privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`).address}`);
} else {
  const key = generatePrivateKey();
  appendEnv("OPERATOR_PRIVATE_KEY", key);
  console.log(`generated operator ${privateKeyToAccount(key).address} (key written to ${ENV_FILE})`);
}
