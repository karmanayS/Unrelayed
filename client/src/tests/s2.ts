// S2 acceptance tests T2.1–T2.6 against the real devnet pool. Exits non-zero on any failure.
import fs from "node:fs";
import path from "node:path";
import { decodeEventLog, getAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN_ID, ETHREX_URL, explorerTx, FRAME_MAX_FEE_PER_GAS, TORNADO } from "../config.js";
import { tornadoAbi, verifierAbi } from "../lib/abis.js";
import { operatorKey } from "../lib/env.js";
import { encodeRaw, newTx, secp256k1Placeholder, senderFrame, signTx, verifyFrame } from "../lib/frameTx.js";
import { sendLegacyAndWait } from "../lib/legacy.js";
import { NOTES_DIR } from "../lib/tornado.js";
import { checkedEvents, deposit, pool, proveWithdrawal, publicInputs, withdrawCalldata } from "../lib/tornado.js";
import { client, getBalance, rpc } from "../lib/rpc.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};
const fresh = (): Address => privateKeyToAccount(generatePrivateKey()).address;

/** verifyProof via eth_call: true/false, or "revert" when the call reverts. */
async function verify(proof: Hex, inputs: readonly bigint[]): Promise<boolean | "revert"> {
  try {
    return await client.readContract({ address: ADDR.TORNADO_VERIFIER, abi: verifierAbi, functionName: "verifyProof", args: [proof, inputs as any] });
  } catch {
    return "revert";
  }
}

// ---- T2.1 deposit ----
console.log("\n== T2.1 deposit");
const a = await deposit(key);
console.log(`deposit tx ${a.saved.depositTx} (${explorerTx(a.saved.depositTx!)}), note file ${a.file}`);
check(a.event.commitment === a.saved.commitment, "Deposit event commitment == our commitment", a.event.commitment);
check(a.event.leafIndex === a.nextIndexBefore, "leafIndex == nextIndex() before the call", `${a.event.leafIndex} vs ${a.nextIndexBefore}`);

// ---- T2.2 root ----
console.log("\n== T2.2 root");
const { events, root } = await checkedEvents();
const lastRoot = await pool.getLastRoot();
check(root === lastRoot, "root computed from Deposit events == getLastRoot()", `${root} (${events.length} leaves)`);
check(await pool.isKnownRoot(root), "isKnownRoot(root)");

// ---- T2.3 proof verifies ----
console.log("\n== T2.3 proof");
const recipientA = fresh();
const relayerA = fresh();
const pA = await proveWithdrawal({ note: a.saved.note, nullifierHash: a.saved.nullifierHash, recipient: recipientA, relayer: relayerA, fee: 1_000_000_000_000_000n });
console.log(`proved in ${pA.proveMs} ms: root ${pA.root} nullifierHash ${pA.nullifierHash}`);
const inputsA = publicInputs(pA);
check((await verify(pA.proof, inputsA)) === true, "Verifier.verifyProof(proof, inputs) == true");

// ---- T2.4 negatives ----
console.log("\n== T2.4 negatives (expect false or revert)");
const names = ["root", "nullifierHash", "recipient", "relayer", "fee", "refund"];
for (let i = 0; i < 6; i++) {
  const mutated = inputsA.map((v, j) => (j === i ? v + 1n : v));
  const r = await verify(pA.proof, mutated);
  check(r !== true, `mutated ${names[i]} (+1)`, String(r));
}
const flipped = ("0x" + pA.proof.slice(2, 2 + 2 * 100) + (parseInt(pA.proof.slice(202, 204), 16) ^ 0x01).toString(16).padStart(2, "0") + pA.proof.slice(204)) as Hex;
check(flipped.length === pA.proof.length && flipped !== pA.proof, "proof byte 100 flipped (sanity)");
const rf = await verify(flipped, inputsA);
check(rf !== true, "flipped proof byte", String(rf));

// ---- T2.5 gas ----
console.log("\n== T2.5 eth_estimateGas(verifyProof)");
const verifyGas = await client.estimateContractGas({ address: ADDR.TORNADO_VERIFIER, abi: verifierAbi, functionName: "verifyProof", args: [pA.proof, inputsA as any], account: operator });
console.log(`INFO  eth_estimateGas verifyProof = ${verifyGas}`);

// Keep the T2.3 proof (an unspent note's real proof) for S3/S4 probes.
fs.writeFileSync(path.join(NOTES_DIR, "s2-proof-A.json"), JSON.stringify({ note: a.file, ...pA }, null, 2) + "\n", { mode: 0o600 });

// ---- T2.6 baseline withdraw (legacy tx) ----
console.log("\n== T2.6 baseline withdraw, legacy tx, relayer = operator, fresh recipient");
const b = await deposit(key);
console.log(`second deposit tx ${b.saved.depositTx}, note file ${b.file}`);
const recipientB = fresh();
const feeB = 1_000_000_000_000_000n; // 0.001 ETH
const pB = await proveWithdrawal({ note: b.saved.note, nullifierHash: b.saved.nullifierHash, recipient: recipientB, relayer: operator, fee: feeB });
check(await getBalance(recipientB) === 0n && (await rpc("eth_getTransactionCount", [recipientB, "latest"])) === "0x0", "recipient is fresh (0 balance, nonce 0)", recipientB);
const data = withdrawCalldata(pB);

// Measurement only (not submitted): the same withdraw as a self-relay frame, simulated by ethrex on the same state,
// gives the execution/state gas split that a legacy receipt does not report.
const nonce = BigInt(await rpc("eth_getTransactionCount", [operator, "pending"]));
const simTx = await signTx(newTx({
  chainId: CHAIN_ID, sender: operator, nonceSeq: nonce, maxFeePerGas: FRAME_MAX_FEE_PER_GAS, signatures: [secp256k1Placeholder()],
  frames: [verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }), senderFrame({ target: ADDR.TORNADO_POOL, execution: 2_000_000n, state: 2_000_000n, data })],
}), key);
const sim = await rpc("ethrex_simulateFrameTransaction", [encodeRaw(simTx)], ETHREX_URL);
console.log("INFO  ethrex_simulateFrameTransaction:", JSON.stringify(sim, (k, v) => (k === "trace" ? undefined : v)));

const balOpBefore = await getBalance(operator);
const { hash, receipt } = await sendLegacyAndWait(key, { to: ADDR.TORNADO_POOL, data, gas: 3_000_000n });
console.log(`withdraw tx ${hash}  ${explorerTx(hash)}`);
check(receipt.status === "0x1", "withdraw tx succeeded");
const balRecipient = await getBalance(recipientB);
check(balRecipient === TORNADO.denomination - feeB, "recipient balance == 1e17 - fee", `${balRecipient}`);
check(await pool.isSpent(pB.nullifierHash), "isSpent(nullifierHash)");
const wTopic = toEventSelector(getAbiItem({ abi: tornadoAbi, name: "Withdrawal" }));
const wLog = receipt.logs.find((l: any) => l.address.toLowerCase() === ADDR.TORNADO_POOL.toLowerCase() && l.topics[0] === wTopic);
const w = wLog && decodeEventLog({ abi: tornadoAbi, eventName: "Withdrawal", data: wLog.data, topics: wLog.topics });
check(!!w && w.args.to === recipientB && w.args.relayer === operator && w.args.fee === feeB && w.args.nullifierHash === pB.nullifierHash, "Withdrawal event (to, nullifierHash, relayer, fee)", w ? JSON.stringify(w.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "missing");
console.log(`INFO  legacy withdraw gasUsed = ${BigInt(receipt.gasUsed)} (effectiveGasPrice ${BigInt(receipt.effectiveGasPrice)})`);
console.log(`INFO  operator balance change = ${(await getBalance(operator)) - balOpBefore} wei (fee in, gas out)`);

fs.writeFileSync(path.join(NOTES_DIR, "s2-results.json"), JSON.stringify({ verifyGas: verifyGas.toString(), withdrawTx: hash, withdrawGasUsed: BigInt(receipt.gasUsed).toString(), sim }, null, 2) + "\n");
console.log(failures ? `\n${failures} check(s) FAILED` : "\nS2: all checks passed");
process.exit(failures ? 1 : 0);
