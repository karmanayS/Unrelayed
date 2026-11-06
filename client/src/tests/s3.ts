// S3 validation-rule probes T3.1–T3.10 on the real devnet (BUILD-PLAN §S3).
// Usage: tsx src/tests/s3.ts [setup|t31|t32|t33|t34|t35|t36|t37|t38|t39|t310|all]
import fs from "node:fs";
import path from "node:path";
import { concat, encodeFunctionData, keccak256, numberToHex, pad, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN_ID, ETHREX_URL, FRAME_MAX_FEE_PER_GAS, STAKE } from "../config.js";
import { registryAbi } from "../lib/abis.js";
import { admission, report, settle, submit, type Attempt } from "../lib/attempt.js";
import { deploy, loadArtifact } from "../lib/deploy.js";
import { operatorKey } from "../lib/env.js";
import { arbitrarySignature, encodeRaw, newTx, senderFrame, verifyFrame, getReputation, type FrameTx, type SignatureEntry } from "../lib/frameTx.js";
import { sendLegacyAndWait } from "../lib/legacy.js";
import { client, getBalance, getCode, rpc } from "../lib/rpc.js";
import { NOTES_DIR, pool } from "../lib/tornado.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
const STATE_FILE = path.join(NOTES_DIR, "s3-state.json");
const RESULTS_FILE = path.join(NOTES_DIR, "s3-results.json");
const probeAbi = loadArtifact("Probe").abi;
const readState = (): any => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {});
const writeState = (p: object) => fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...p }, null, 2) + "\n");
const results: Record<string, unknown> = fs.existsSync(RESULTS_FILE) ? JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) : {};
const saveResult = (k: string, v: unknown) => {
  results[k] = v;
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
};
let failures = 0;
const log = (a: Attempt) => {
  console.log(report(a));
  if (!a.pass) failures++;
  return a;
};
/** pool.nextIndex() — a harmless view call used as a SENDER frame body. */
const NEXT_INDEX = toFunctionSelector("nextIndex()");
const randKey = (bits = 64): bigint => BigInt(keccak256(generatePrivateKey())) >> BigInt(256 - bits);
const nonceSlot = (sender: Address, k: bigint): Hex => keccak256(concat([pad(sender, { size: 32 }), numberToHex(k, { size: 32 })]));
const seqOf = async (sender: Address, k: bigint) => BigInt(await rpc("eth_getStorageAt", [ADDR.NONCE_MANAGER, nonceSlot(sender, k), "latest"]));

// ------------------------------------------------------------------------------------------------- builders ----

let SIGS: SignatureEntry[] = readState().sigForm === "arbitrary" ? [arbitrarySignature()] : [];

function probeTx(o: {
  probe: Address; fn: string; args?: unknown[]; verifyGas?: bigint; nonceKeys?: bigint[]; nonceSeq?: bigint;
  signatures?: SignatureEntry[]; maxFee?: bigint; senderTo?: Address; senderValue?: bigint; senderData?: Hex;
}): FrameTx {
  const data = encodeFunctionData({ abi: probeAbi, functionName: o.fn, args: o.args ?? [] });
  return newTx({
    chainId: CHAIN_ID, sender: o.probe, nonceKeys: o.nonceKeys ?? [randKey()], nonceSeq: o.nonceSeq ?? 0n,
    maxFeePerGas: o.maxFee ?? FRAME_MAX_FEE_PER_GAS, signatures: o.signatures ?? SIGS,
    frames: [
      verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: o.verifyGas ?? 80_000n, data }),
      senderFrame({ target: o.senderTo ?? operator, execution: 30_000n, value: o.senderValue ?? 0n, data: o.senderData ?? "0x" }),
    ],
  });
}

const run = async (label: string, tx: FrameTx, expect: "admit" | "reject") => log(await settle(await submit(label, tx, expect)));
const S = () => readState() as { probeU: Address; probeS: Address; reverter: Address };

// ---------------------------------------------------------------------------------------------------- tests ----

async function setup() {
  const st = readState();
  for (const name of ["probeU", "probeS"] as const) {
    if (st[name] && (await getCode(st[name])) !== "0x") {
      console.log(`${name} exists at ${st[name]}`);
      continue;
    }
    const d = await deploy(key, "Probe", [ADDR.STAKING_REGISTRY], 100_000_000_000_000_000n); // 0.1 ETH float
    console.log(`deployed ${name} ${d.address} tx ${d.hash} gasUsed ${BigInt(d.receipt.gasUsed)}`);
    writeState({ [name]: d.address, [`${name}DeployTx`]: d.hash });
  }
  if (!st.reverter || (await getCode(st.reverter)) === "0x") {
    const d = await deploy(key, "RevertingReceiver", [], 0n, 2_000_000n);
    console.log(`deployed RevertingReceiver ${d.address} tx ${d.hash}`);
    writeState({ reverter: d.address });
  }
}

async function stakeProbe() {
  const { probeS } = S();
  const info = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [probeS] });
  if (info[0] >= STAKE.amount && info[2] === 0n) return console.log(`probeS already staked: ${info}`);
  const data = encodeFunctionData({ abi: probeAbi, functionName: "stake", args: [STAKE.unstakeDelaySec] });
  const { hash } = await sendLegacyAndWait(key, { to: probeS, data, value: STAKE.amount, gas: 500_000n });
  console.log(`probeS.stake tx ${hash}`);
  writeState({ stakeTx: hash });
}

async function t31() {
  console.log("\n== T3.1 contract sender with no signer");
  const { probeU } = S();
  const none = await settle(await submit("signatures = [] (account nonce)", probeTx({ probe: probeU, fn: "vPlain", signatures: [], nonceKeys: [0n], nonceSeq: BigInt(await rpc("eth_getTransactionCount", [probeU, "latest"])) }), "admit"));
  console.log(report(none));
  let form = none.pass ? "none" : undefined;
  let arb: Attempt | undefined;
  if (!none.pass) {
    arb = await settle(await submit("signatures = [ARBITRARY]", probeTx({ probe: probeU, fn: "vPlain", signatures: [arbitrarySignature()], nonceKeys: [0n], nonceSeq: BigInt(await rpc("eth_getTransactionCount", [probeU, "latest"])) }), "admit"));
    console.log(report(arb));
    if (arb.pass) form = "arbitrary";
  }
  if (!form) failures++;
  console.log(`RESULT signature form accepted: ${form ?? "NEITHER -> escalate"}`);
  writeState({ sigForm: form });
  SIGS = form === "arbitrary" ? [arbitrarySignature()] : [];
  saveResult("t31", { none, arb, form, admission: await admission((arb ?? none).hash) });
}

async function t32() {
  console.log("\n== T3.2 keyed nonce on the contract sender");
  const { probeU } = S();
  const out: any[] = [];
  const nh = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s2-proof-A.json"), "utf8")).nullifierHash as Hex;
  const keys: [string, bigint][] = [
    ["64-bit random", randKey(64)],
    ["254-bit (real nullifierHash of note A)", BigInt(nh)],
    ["255-bit (2^255 - 1)", (1n << 255n) - 1n],
    ["256-bit (2^256 - 1)", (1n << 256n) - 1n],
  ];
  for (const [label, k] of keys) {
    const before = await seqOf(probeU, k);
    const a = await settle(await submit(`nonceKeys=[${label}] seq 0`, probeTx({ probe: probeU, fn: "vPlain", nonceKeys: [k] }), "admit"));
    const after = await seqOf(probeU, k);
    console.log(report(a) + ` | NONCE_MANAGER seq ${before} -> ${after}`);
    const ok = a.pass && before === 0n && after === 1n;
    if (!ok) console.log(`INFO  key ${label} not usable end to end`);
    out.push({ label, key: "0x" + k.toString(16), bitLength: k.toString(2).length, attempt: a, seqBefore: before, seqAfter: after, ok });
  }
  if (!out[0].ok) failures++;
  const maxOk = out.filter((o) => o.ok).map((o) => o.bitLength);
  console.log(`RESULT max accepted key width: ${maxOk.length ? Math.max(...maxOk) : "none"} bits`);
  saveResult("t32", out);
}

async function t33() {
  console.log("\n== T3.3 duplicate (sender, key, seq 0)");
  const { probeU } = S();
  const k = randKey();
  const other: Address = privateKeyToAccount(generatePrivateKey()).address;
  const tx1 = probeTx({ probe: probeU, fn: "vPlain", nonceKeys: [k], senderTo: operator });
  const tx2 = probeTx({ probe: probeU, fn: "vPlain", nonceKeys: [k], senderTo: ADDR.TORNADO_POOL, senderData: NEXT_INDEX }); // different body, same fee
  const tx3 = probeTx({ probe: probeU, fn: "vPlain", nonceKeys: [k], senderTo: ADDR.TORNADO_POOL, senderData: NEXT_INDEX, maxFee: (FRAME_MAX_FEE_PER_GAS * 12n) / 10n }); // same body as tx2, +20% fee
  void other;
  const a1 = await submit("tx1 (key K', seq 0)", tx1, "admit");
  const a2 = await submit("tx2: different tx, same (sender, K', seq 0), same fee", tx2, "reject");
  const a3 = await submit("tx3: same slot, +20% fee (replacement)", tx3, "admit");
  const status = async (h: Hex) => rpc("skandha_frameTransactionStatus", [h]).then((s: any) => s.status, (e: Error) => `error: ${e.message}`);
  const pendingNow = { tx1: await status(a1.hash), tx2: await status(a2.hash), tx3: await status(a3.hash) };
  console.log(`INFO  immediately after: tx1=${pendingNow.tx1} tx2=${pendingNow.tx2} tx3=${pendingNow.tx3}`);
  console.log(`INFO  tx1: ${a1.outcome}${a1.error ? " " + a1.error : ""}`);
  console.log(`INFO  tx2: ${a2.outcome}${a2.error ? " " + a2.error : ""}`);
  console.log(`INFO  tx3: ${a3.outcome}${a3.error ? " " + a3.error : ""}`);
  // Wait two+ blocks, then see which were included.
  await new Promise((r) => setTimeout(r, 20_000));
  const receipts = await Promise.all([a1, a2, a3].map((a) => rpc("eth_getTransactionReceipt", [a.hash])));
  const included = receipts.map((r, i) => (r ? `tx${i + 1}` : null)).filter(Boolean);
  const finalStatus = { tx1: await status(a1.hash), tx2: await status(a2.hash), tx3: await status(a3.hash) };
  console.log(`INFO  after 20 s: included = [${included.join(", ")}]; status tx1=${finalStatus.tx1} tx2=${finalStatus.tx2} tx3=${finalStatus.tx3}; NONCE_MANAGER seq = ${await seqOf(probeU, k)}`);
  const pendingBoth = [pendingNow.tx1, pendingNow.tx2, pendingNow.tx3].filter((s) => s === "Pending" || s === "New" || s === "Submitted").length;
  const r3 = receipts[2];
  const ok = included.length <= 1 && a2.outcome === "rejected" && (!r3 || (r3.status === "0x1" && r3.frameReceipts.every((f: any) => f.status === "0x1")));
  console.log(`${ok ? "PASS" : "FAIL"}  never two included (${included.length}) and the same-fee duplicate was rejected`);
  if (!ok) failures++;
  saveResult("t33", { key: k, a1, a2, a3, pendingNow, finalStatus, included, pendingBoth, adm: { tx1: await admission(a1.hash), tx2: await admission(a2.hash), tx3: await admission(a3.hash) } });
}

async function t34() {
  console.log("\n== T3.4 staking");
  const { probeS } = S();
  await stakeProbe();
  const [stake, delay, withdrawTime] = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [probeS] });
  const ok = stake >= STAKE.amount && delay === STAKE.unstakeDelaySec && withdrawTime === 0n;
  console.log(`${ok ? "PASS" : "FAIL"}  getDepositInfo(probeS) = stake ${stake}, delay ${delay}, withdrawTime ${withdrawTime}`);
  if (!ok) failures++;
  const a = await run("staked probe plain tx (for the admission report)", probeTx({ probe: probeS, fn: "vPlain" }), "admit");
  const adm = await admission(a.hash);
  const rep = await getReputation(probeS);
  console.log(`INFO  reputation entry: ${JSON.stringify(rep)}`);
  console.log(`INFO  admission checks: ${JSON.stringify(adm?.checks)}`);
  if (!rep?.isStaked) {
    console.log("FAIL  explorer reputation does not show probeS as staked");
    failures++;
  } else console.log("PASS  explorer reputation shows probeS isStaked = true");
  saveResult("t34", { stake, delay, withdrawTime, attempt: a, adm, rep, stakeTx: readState().stakeTx });
}

async function t35() {
  console.log("\n== T3.5 external reads (STORAGE-032)");
  const { probeU, probeS } = S();
  const pa = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s2-proof-A.json"), "utf8"));
  const root = await pool.getLastRoot();
  const args = [ADDR.TORNADO_POOL, root, true, pa.nullifierHash, false];
  const u = await run("unstaked probe reads isKnownRoot/isSpent (correct values)", probeTx({ probe: probeU, fn: "vTornadoReads", args, verifyGas: 90_000n }), "reject");
  const s = await run("staked probe reads isKnownRoot/isSpent (correct values)", probeTx({ probe: probeS, fn: "vTornadoReads", args, verifyGas: 200_000n }), "admit");
  const w = await run("staked probe, wrong expected (isSpent = true)", probeTx({ probe: probeS, fn: "vTornadoReads", args: [ADDR.TORNADO_POOL, root, true, pa.nullifierHash, true], verifyGas: 200_000n }), "reject");
  saveResult("t35", { u, s, w, admS: await admission(s.hash), admU: await admission(u.hash) });
}

async function t36() {
  console.log("\n== T3.6 deployed Tornado Verifier inside VERIFY (staked probe)");
  const { probeS } = S();
  const pa = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s2-proof-A.json"), "utf8"));
  const input = [pa.root, pa.nullifierHash, pa.recipient, pa.relayer, pa.fee, pa.refund].map((x: string) => BigInt(x));
  const a = log(await settle(await submit("vVerifier(deployed Verifier, real proof, expect true)", probeTx({ probe: probeS, fn: "vVerifier", args: [ADDR.TORNADO_VERIFIER, pa.proof, input, true], verifyGas: 600_000n }), "reject")));
  const gasRule = /GAS/.test(a.error ?? "");
  console.log(`RESULT ${a.outcome === "rejected" ? (gasRule ? "rejected citing GAS -> S4 (PRE-APPROVED)" : "rejected for ANOTHER reason -> ESCALATE") : "ADMITTED -> skip S4"}`);
  saveResult("t36", { a, adm: await admission(a.hash) });
}

/** Simulates `tx` with ethrex and returns its maxCost. */
const simMaxCost = async (tx: FrameTx): Promise<bigint> => BigInt((await rpc("ethrex_simulateFrameTransaction", [encodeRaw(tx)], ETHREX_URL)).maxCost);

async function t37() {
  console.log("\n== T3.7 introspection values (staked probe)");
  const { probeS } = S();
  const TP = { NONCE: 1, MAX_FEE: 4, MAX_COST: 6, FRAME_COUNT: 9, CURRENT_FRAME_INDEX: 10, NONCE_KEY_COUNT: 14, NONCE_KEY_0: 16 };
  const out: Record<string, unknown> = {};
  // txparam, all but MAX_COST
  {
    const k = randKey();
    const ids = [TP.FRAME_COUNT, TP.CURRENT_FRAME_INDEX, TP.NONCE, TP.NONCE_KEY_COUNT, TP.NONCE_KEY_0, TP.MAX_FEE];
    const exp = [2n, 0n, 0n, 1n, k, FRAME_MAX_FEE_PER_GAS];
    out.txparams = await run(`txparam FRAME_COUNT=2 CURRENT_FRAME_INDEX=0 NONCE=0 NONCE_KEY_COUNT=1 NONCE_KEY_0=K MAX_FEE=${FRAME_MAX_FEE_PER_GAS}`, probeTx({ probe: probeS, fn: "vTxParams", args: [ids, exp], nonceKeys: [k], verifyGas: 150_000n }), "admit");
    const k2 = randKey();
    out.txparamsWrong = await run("txparam with a wrong FRAME_COUNT (3)", probeTx({ probe: probeS, fn: "vTxParams", args: [ids, [3n, 0n, 0n, 1n, k2, FRAME_MAX_FEE_PER_GAS]], nonceKeys: [k2], verifyGas: 150_000n }), "reject");
  }
  // MAX_COST: the client's value is ethrex's own maxCost for the exact bytes, found as a fixed point (the expected
  // value is part of the calldata, which affects intrinsic gas).
  {
    const k = randKey();
    let guess = 0n;
    let tx = probeTx({ probe: probeS, fn: "vTxParams", args: [[TP.MAX_COST], [guess]], nonceKeys: [k], verifyGas: 150_000n });
    for (let i = 0; i < 5; i++) {
      const m = await simMaxCost(tx);
      if (m === guess) break;
      guess = m;
      tx = probeTx({ probe: probeS, fn: "vTxParams", args: [[TP.MAX_COST], [guess]], nonceKeys: [k], verifyGas: 150_000n });
    }
    const limits = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
    console.log(`INFO  ethrex maxCost = ${guess} = ${guess / FRAME_MAX_FEE_PER_GAS} gas x maxFee; frame limits sum = ${limits} (intrinsic part ${guess / FRAME_MAX_FEE_PER_GAS - limits})`);
    out.maxCostValue = guess;
    out.maxCost = await run(`txparam MAX_COST == ${guess}`, tx, "admit");
    const k2 = randKey();
    out.maxCostWrong = await run("txparam MAX_COST == value + 1 (wrong)", probeTx({ probe: probeS, fn: "vTxParams", args: [[TP.MAX_COST], [guess + 1n]], nonceKeys: [k2], verifyGas: 150_000n }), "reject");
  }
  // frameparam(1, …)
  {
    const FP = { RESOLVED_TARGET: 0, EXECUTION_GAS_LIMIT: 1, MODE: 2, FLAGS: 3, DATA_LENGTH: 4, VALUE: 8, STATE_GAS_LIMIT: 9 };
    const ids = [FP.MODE, FP.RESOLVED_TARGET, FP.VALUE, FP.FLAGS, FP.EXECUTION_GAS_LIMIT, FP.STATE_GAS_LIMIT, FP.DATA_LENGTH];
    const senderData: Hex = NEXT_INDEX;
    const exp = [2n, BigInt(ADDR.TORNADO_POOL), 0n, 0n, 30_000n, 0n, 4n];
    out.frameparams = await run("frameparam(1): MODE=2 RESOLVED_TARGET=pool VALUE=0 FLAGS=0 EXEC_LIMIT=30000 STATE_LIMIT=0 DATA_LENGTH=4", probeTx({ probe: probeS, fn: "vFrameParams", args: [1n, ids, exp], senderTo: ADDR.TORNADO_POOL, senderData, verifyGas: 150_000n }), "admit");
    out.frameparamsWrong = await run("frameparam(1) with a wrong RESOLVED_TARGET", probeTx({ probe: probeS, fn: "vFrameParams", args: [1n, ids, [2n, BigInt(operator), 0n, 0n, 30_000n, 0n, 4n]], senderTo: ADDR.TORNADO_POOL, senderData, verifyGas: 150_000n }), "reject");
    // VALUE and ATOMIC_BATCH flag readings with a non-zero value and flagged frame are exercised in S5 negatives.
    out.frameValue = await run("frameparam(1).VALUE == 7 (frame 1 sends 7 wei to the operator)", probeTx({ probe: probeS, fn: "vFrameParams", args: [1n, [FP.VALUE], [7n]], senderValue: 7n, verifyGas: 150_000n }), "admit");
  }
  // framedatacopy(0, len, 1)
  {
    const pa = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s2-proof-A.json"), "utf8"));
    const senderData = encodeFunctionData({ abi: [{ type: "function", name: "isSpent", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }], functionName: "isSpent", args: [pa.nullifierHash] });
    const len = BigInt((senderData.length - 2) / 2);
    out.framedata = await run(`framedatacopy(0, ${len}, 1) == frame 1 data`, probeTx({ probe: probeS, fn: "vFrameData", args: [1n, len, keccak256(senderData)], senderTo: ADDR.TORNADO_POOL, senderData, verifyGas: 150_000n }), "admit");
    out.framedataWrong = await run("framedatacopy with a wrong expected hash", probeTx({ probe: probeS, fn: "vFrameData", args: [1n, len, keccak256("0x00")], senderTo: ADDR.TORNADO_POOL, senderData, verifyGas: 150_000n }), "reject");
  }
  saveResult("t37", out);
}

async function t38() {
  console.log("\n== T3.8 SELFBALANCE");
  const { probeU, probeS } = S();
  const bS = await getBalance(probeS);
  const bU = await getBalance(probeU);
  const s = await run(`staked: address(this).balance == ${bS}`, probeTx({ probe: probeS, fn: "vSelfBalance", args: [bS], verifyGas: 100_000n }), "admit");
  const w = await run("staked: wrong expected balance", probeTx({ probe: probeS, fn: "vSelfBalance", args: [bS + 1n], verifyGas: 100_000n }), "reject");
  const u = await run(`unstaked: address(this).balance == ${bU} (correct value)`, probeTx({ probe: probeU, fn: "vSelfBalance", args: [bU], verifyGas: 90_000n }), "reject");
  saveResult("t38", { s, w, u });
}

async function t39() {
  console.log("\n== T3.9 EXTCODESIZE in VERIFY (staked probe)");
  const { probeS, reverter } = S();
  const never: Address = privateKeyToAccount(generatePrivateKey()).address;
  const size = BigInt((((await getCode(reverter)) as string).length - 2) / 2);
  const e = await run(`never-used address ${never}: code.length == 0`, probeTx({ probe: probeS, fn: "vCodeSize", args: [never, 0n], verifyGas: 100_000n }), "admit");
  const c = await run(`contract ${reverter}: code.length == ${size}`, probeTx({ probe: probeS, fn: "vCodeSize", args: [reverter, size], verifyGas: 100_000n }), "admit");
  const w = await run("contract: wrong expected size 0", probeTx({ probe: probeS, fn: "vCodeSize", args: [reverter, 0n], verifyGas: 100_000n }), "reject");
  saveResult("t39", { e, c, w, never, size });
}

async function t310() {
  console.log("\n== T3.10 msg.sender in VERIFY");
  const { probeS } = S();
  const a = await run(`msg.sender == ENTRY_POINT ${ADDR.ENTRY_POINT}`, probeTx({ probe: probeS, fn: "vCaller", args: [ADDR.ENTRY_POINT] }), "admit");
  const w = await run("msg.sender == operator (wrong)", probeTx({ probe: probeS, fn: "vCaller", args: [operator] }), "reject");
  saveResult("t310", { a, w });
}

const steps: Record<string, () => Promise<void>> = { setup, t31, t32, t33, t34, t35, t36, t37, t38, t39, t310 };
const which = process.argv.slice(2);
const order = which.length === 0 || which.includes("all") ? Object.keys(steps) : which;
for (const s of order) await steps[s]();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall selected S3 checks passed");
process.exit(failures ? 1 : 0);
