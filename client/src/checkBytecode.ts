// yarn check:bytecode (BUILD-PLAN §S4 task 3): disassembles our compiled contracts' runtime code with
// `cast disassemble` and fails if any GAS opcode is not immediately followed by CALL, STATICCALL, DELEGATECALL or
// CALLCODE (the alt-mempool's GAS rule for validation code). Contracts are compiled without CBOR metadata
// (foundry.toml), so the whole runtime code is instructions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/localState.js";

const CONTRACTS = (process.env.CHECK_CONTRACTS ?? "Groth16TornadoVerifier,TornadoExit").split(",");
const OK_NEXT = new Set(["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"]);
let failures = 0;
for (const name of CONTRACTS) {
  const file = path.join(REPO_ROOT, "contracts", "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${name}: ${file} not built`);
    continue;
  }
  const code: string = JSON.parse(fs.readFileSync(file, "utf8")).deployedBytecode.object;
  const asm = execFileSync("cast", ["disassemble", code], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n");
  const ops = asm.map((l) => l.split(":").slice(1).join(":").trim().split(/\s+/)[0]);
  const bad: string[] = [];
  let gasCount = 0;
  ops.forEach((op, i) => {
    if (op !== "GAS") return;
    gasCount++;
    if (!OK_NEXT.has(ops[i + 1])) bad.push(`${asm[i]}  ->  ${asm[i + 1] ?? "<end>"}`);
  });
  const ok = bad.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${(code.length - 2) / 2} bytes, ${ops.length} instructions, ${gasCount} GAS opcode(s), ${bad.length} not followed by *CALL`);
  bad.forEach((b) => console.log(`        ${b}`));
  if (!ok) failures++;
}
process.exit(failures ? 1 : 0);
