// Deploys a compiled contract (contracts/out) with a legacy tx from `key`.
import fs from "node:fs";
import path from "node:path";
import { encodeDeployData, type Abi, type Address, type Hex } from "viem";
import { sendLegacyAndWait } from "./legacy.js";
import { REPO_ROOT } from "./localState.js";

export function loadArtifact(file: string, name = file): { abi: Abi; bytecode: Hex } {
  const p = path.join(REPO_ROOT, "contracts", "out", `${file}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`${p} missing: run \`forge build\` in contracts/`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** HegotaSupport's constructor CREATEs one helper per opcode; contract creation also costs state gas: use a big limit. */
export async function deploy(key: Hex, file: string, args: unknown[] = [], value = 0n, gas = 12_000_000n): Promise<{ address: Address; hash: Hex; receipt: any }> {
  const { abi, bytecode } = loadArtifact(file);
  const data = encodeDeployData({ abi, bytecode, args });
  const { hash, receipt } = await sendLegacyAndWait(key, { to: null, data, value, gas });
  if (!receipt.contractAddress) throw new Error(`deploy ${file}: no contractAddress in ${hash}`);
  return { address: receipt.contractAddress, hash, receipt };
}
