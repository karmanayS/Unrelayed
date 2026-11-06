// S4 acceptance tests T4.1–T4.5 for the embedded verifier (BUILD-PLAN §S4).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN_ID, FRAME_MAX_FEE_PER_GAS } from "../config.js";
import { verifierAbi } from "../lib/abis.js";
import { report, settle, submit } from "../lib/attempt.js";
import { deploy, loadArtifact } from "../lib/deploy.js";
import { operatorKey } from "../lib/env.js";
import { keccak256 } from "viem";
import { newTx, senderFrame, verifyFrame } from "../lib/frameTx.js";
import { REPO_ROOT } from "../lib/localState.js";
import { client, getCode } from "../lib/rpc.js";
import { loadNote, NOTES_DIR, proveWithdrawal, publicInputs } from "../lib/tornado.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};
const STATE = path.join(NOTES_DIR, "s4-state.json");
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const s3 = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s3-state.json"), "utf8"));

// ---- T4.1 VK identical ----
console.log("\n== T4.1 verifying key constants vs the deployed Verifier");
const src = fs.readFileSync(path.join(REPO_ROOT, "contracts/src/Groth16TornadoVerifier.sol"), "utf8");
const vkSrc = src.slice(src.indexOf("function _vk()"), src.indexOf("// ---", src.indexOf("function _vk()")));
const ours = [...vkSrc.matchAll(/\b(\d{60,})\b/g)].map((m) => BigInt(m[1]));
const deployedCode = await getCode(ADDR.TORNADO_VERIFIER);
const asm = execFileSync("cast", ["disassemble", deployedCode], { encoding: "utf8", maxBuffer: 1 << 26 });
const deployedPush32 = [...asm.matchAll(/PUSH32 0x([0-9a-fA-F]+)/g)].map((m) => BigInt("0x" + m[1]));
let lastPos = -1;
let inOrder = true;
ours.forEach((c, i) => {
  const pos = deployedPush32.indexOf(c, lastPos + 1);
  const found = deployedPush32.includes(c);
  console.log(`  ${String(i).padStart(2)} 0x${c.toString(16).padStart(64, "0")} ${found ? `PUSH32 #${deployedPush32.indexOf(c)}` : "NOT FOUND"}`);
  if (pos < 0) inOrder = false;
  else lastPos = pos;
});
check(ours.length === 28, "our contract has 28 VK constants (alfa1 2 + beta2 4 + gamma2 4 + delta2 4 + IC 7x2)", String(ours.length));
check(ours.every((c) => deployedPush32.includes(c)), "every VK constant is a PUSH32 operand of the deployed Verifier");
check(inOrder, "in the same order");
const ourRuntime: string = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "contracts/out/Groth16TornadoVerifier.sol/Groth16TornadoVerifier.json"), "utf8")).deployedBytecode.object;
check(ours.every((c) => ourRuntime.toLowerCase().includes(c.toString(16).padStart(64, "0"))), "every VK constant is also in our compiled runtime code");

// ---- deploy ----
let ourVerifier: Address = st.verifier;
const builtRuntime: string = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "contracts/out/Groth16TornadoVerifier.sol/Groth16TornadoVerifier.json"), "utf8")).deployedBytecode.object;
if (!st.verifier || (await getCode(st.verifier)).toLowerCase() !== builtRuntime.toLowerCase()) {
  const d = await deploy(key, "Groth16TornadoVerifier");
  ourVerifier = d.address;
  fs.writeFileSync(STATE, JSON.stringify({ verifier: d.address, deployTx: d.hash }, null, 2) + "\n");
  console.log(`\ndeployed Groth16TornadoVerifier ${d.address} tx ${d.hash}`);
} else console.log(`\nGroth16TornadoVerifier at ${ourVerifier} (code matches the build)`);

// ---- T4.2 equivalence ----
console.log("\n== T4.2 equivalence with the deployed Verifier (eth_call), 3 real proofs x (1 + 7 mutations)");
const call = async (verifier: Address, proof: Hex, inputs: readonly bigint[]): Promise<string> => {
  try {
    return String(await client.readContract({ address: verifier, abi: verifierAbi, functionName: "verifyProof", args: [proof, inputs as any] }));
  } catch {
    return "revert";
  }
};
const noteA = await loadNote(fs.readdirSync(NOTES_DIR).filter((f) => f.startsWith("note-")).map((f) => path.join(NOTES_DIR, f)).find((f) => JSON.parse(fs.readFileSync(f, "utf8")).leafIndex === 0)!);
const proofs = [];
for (let i = 0; i < 3; i++) {
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const relayer = i === 0 ? operator : privateKeyToAccount(generatePrivateKey()).address;
  const p = await proveWithdrawal({ note: noteA.note, nullifierHash: noteA.nullifierHash, recipient, relayer, fee: BigInt(i) * 10n ** 15n });
  proofs.push(p);
}
const flip = (proof: Hex, byte: number): Hex => {
  const b = Buffer.from(proof.slice(2), "hex");
  b[byte] ^= 0x01;
  return ("0x" + b.toString("hex")) as Hex;
};
let gasOurs = 0n;
let gasDeployed = 0n;
for (const [pi, p] of proofs.entries()) {
  const inputs = publicInputs(p);
  const cases: [string, Hex, readonly bigint[]][] = [["valid", p.proof, inputs]];
  ["root", "nullifierHash", "recipient", "relayer", "fee", "refund"].forEach((n, j) => cases.push([`${n}+1`, p.proof, inputs.map((v, k) => (k === j ? v + 1n : v))]));
  cases.push(["proof byte 100 flipped", flip(p.proof, 100), inputs]);
  for (const [label, proof, inp] of cases) {
    const [a, b] = [await call(ADDR.TORNADO_VERIFIER, proof, inp), await call(ourVerifier, proof, inp)];
    check(a === b, `proof ${pi} ${label}: deployed=${a} ours=${b}`);
  }
  if (pi === 0) {
    gasDeployed = await client.estimateContractGas({ address: ADDR.TORNADO_VERIFIER, abi: verifierAbi, functionName: "verifyProof", args: [p.proof, inputs as any], account: operator });
    gasOurs = await client.estimateContractGas({ address: ourVerifier, abi: verifierAbi, functionName: "verifyProof", args: [p.proof, inputs as any], account: operator });
    console.log(`INFO  eth_estimateGas verifyProof: deployed ${gasDeployed}, ours ${gasOurs}`);
  }
}
check((await call(ourVerifier, proofs[0].proof, publicInputs(proofs[0]))) === "true", "sanity: a valid proof is true on ours");

// ---- T4.3 ----
console.log("\n== T4.3 check:bytecode");
try {
  console.log(execFileSync("npx", ["tsx", "src/checkBytecode.ts"], { encoding: "utf8", env: { ...process.env, CHECK_CONTRACTS: "Groth16TornadoVerifier" } }).trim());
  check(true, "check:bytecode passes for Groth16TornadoVerifier");
} catch (e) {
  check(false, "check:bytecode", (e as any).stdout);
}

// ---- T4.4 / T4.5 admission through the staked probe ----
console.log("\n== T4.4 / T4.5 staked probe calls our verifier inside VERIFY");
const probeAbi = loadArtifact("Probe").abi;
const randKey = () => BigInt(keccak256(generatePrivateKey())) >> 192n;
const probeTx = (proof: Hex, inputs: readonly bigint[], expected: boolean) => newTx({
  chainId: CHAIN_ID, sender: s3.probeS, nonceKeys: [randKey()], nonceSeq: 0n, maxFeePerGas: FRAME_MAX_FEE_PER_GAS, signatures: [],
  frames: [
    verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: 600_000n, data: encodeFunctionData({ abi: probeAbi, functionName: "vVerifier", args: [ourVerifier, proof, inputs, expected] }) }),
    senderFrame({ target: operator, execution: 30_000n }),
  ],
});
const p0 = proofs[0];
const ok = await settle(await submit("T4.4 real proof, expect true", probeTx(p0.proof, publicInputs(p0), true), "admit"));
console.log(report(ok));
if (!ok.pass) failures++;
const f0 = ok.receipt?.frameReceipts?.[0] as any;
if (f0) {
  const g = BigInt(f0.gasUsed);
  console.log(`INFO  VERIFY frame gasUsed ${g} (limit 600,000; staked budget 1,000,000)`);
  check(g < 1_000_000n, "VERIFY gas well under the 1,000,000 staked budget", String(g));
}
const bad1 = await settle(await submit("T4.5 proof with one byte flipped, expect true", probeTx(flip(p0.proof, 100), publicInputs(p0), true), "reject"));
console.log(report(bad1));
if (!bad1.pass) failures++;
const bad2 = await settle(await submit("T4.5 valid proof but wrong recipient input, expect true", probeTx(p0.proof, publicInputs(p0).map((v, i) => (i === 2 ? v + 1n : v)), true), "reject"));
console.log(report(bad2));
if (!bad2.pass) failures++;

fs.writeFileSync(path.join(NOTES_DIR, "s4-results.json"), JSON.stringify({ ourVerifier, gasOurs, gasDeployed, ok, bad1, bad2 }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log(failures ? `\n${failures} check(s) FAILED` : "\nS4: all checks passed");
process.exit(failures ? 1 : 0);
