// S5 acceptance tests T5.1–T5.8 against the live, staked TornadoExit (BUILD-PLAN §S5).
// Usage: tsx src/tests/s5.ts [t51|t52|t53|t54|t55|t56|t57|t58|all]
import fs from "node:fs";
import path from "node:path";
import { concat, decodeEventLog, encodeFunctionData, getAbiItem, keccak256, numberToHex, pad, toEventSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, ETHREX_URL, explorerTx, LEGACY_GAS_PRICE, STAKE, TORNADO } from "../config.js";
import { EXIT } from "../deployments.js";
import { registryAbi, tornadoAbi } from "../lib/abis.js";
import { admission, report, settle, submit, type Attempt } from "../lib/attempt.js";
import { deploy } from "../lib/deploy.js";
import { operatorKey } from "../lib/env.js";
import { buildExitWithdrawTx, exitAbi, exitTx, keyFor, maxCostOf, MIN_WITHDRAW_EXEC_GAS, MIN_WITHDRAW_STATE_GAS, quoteFee } from "../lib/exit.js";
import { encodeRaw, getReputation, senderFrame } from "../lib/frameTx.js";
import { sendLegacy, sendLegacyAndWait, waitReceipt } from "../lib/legacy.js";
import { prove, type WithdrawProof } from "../lib/prover.js";
import { client, getBalance, getCode, rpc } from "../lib/rpc.js";
import { checkedEvents, deposit, fetchDepositEvents, loadNote, NOTES_DIR, pool, withdrawCalldata, type SavedNote } from "../lib/tornado.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
const RESULTS = process.env.S5_RESULTS ?? path.join(NOTES_DIR, "s5-results.json");
/** e2e mode (yarn test:e2e): after each test's assertions, sweep fresh recipients back to the operator and reuse
 * notes that the rejections left unspent, so repeated runs fit the devnet budget. Never changes what is asserted. */
const SWEEP = process.env.SWEEP === "1";
const FRESH_UNSTAKED = process.env.FRESH_UNSTAKED === "1";
const spare: SavedNote[] = [];
const recipientKeys = new Map<string, Hex>();
const results: Record<string, unknown> = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : {};
const save = (k: string, v: unknown) => {
  results[k] = v;
  fs.writeFileSync(RESULTS, JSON.stringify(results, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
};
let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
};
const logA = (a: Attempt) => {
  console.log(report(a));
  if (!a.pass) failures++;
  return a;
};
const fresh = (): Address => {
  const k = generatePrivateKey();
  const a = privateKeyToAccount(k).address;
  recipientKeys.set(a.toLowerCase(), k);
  return a;
};
/** e2e only: returns a funded fresh recipient's balance to the operator (after the test has checked it). */
async function sweep(addr: Address) {
  const k = recipientKeys.get(addr.toLowerCase());
  const bal = await getBalance(addr);
  const gas = 21_000n * LEGACY_GAS_PRICE;
  if (!SWEEP || !k || bal <= gas) return;
  const { hash } = await sendLegacyAndWait(k, { to: operator, value: bal - gas, gas: 21_000n });
  console.log(`INFO  e2e cleanup: swept ${bal - gas} wei from ${addr} back to the operator (${hash})`);
}
const nextNote = async (): Promise<SavedNote> => spare.shift() ?? (await deposit(key)).saved;
const exitBal = () => getBalance(EXIT.address);
const nonceSlot = (sender: Address, k: bigint): Hex => keccak256(concat([pad(sender, { size: 32 }), numberToHex(k, { size: 32 })]));
const seqOf = async (sender: Address, k: bigint) => BigInt(await rpc("eth_getStorageAt", [ADDR.NONCE_MANAGER, nonceSlot(sender, k), "latest"]));
const W_TOPIC = toEventSelector(getAbiItem({ abi: tornadoAbi, name: "Withdrawal" }));
const withdrawalEvent = (receipt: any) => {
  const logs = [...(receipt.logs ?? []), ...(receipt.frameReceipts ?? []).flatMap((f: any) => f.logs ?? [])];
  const l = logs.find((x: any) => x.address?.toLowerCase() === ADDR.TORNADO_POOL.toLowerCase() && x.topics?.[0] === W_TOPIC);
  return l ? decodeEventLog({ abi: tornadoAbi, eventName: "Withdrawal", data: l.data, topics: l.topics }).args : undefined;
};
const gasCost = (r: any) => BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
/** Proves from the chain's Deposit events without the client-side root/spent checks (negative tests need that). */
const proveRaw = async (n: SavedNote, o: { recipient: Address; relayer?: Address; fee: bigint; refund?: bigint }): Promise<WithdrawProof> => {
  const events = await fetchDepositEvents();
  return prove({ note: n.note, events, recipient: o.recipient, relayer: o.relayer ?? EXIT.address, fee: o.fee, refund: o.refund });
};
// keccak output can exceed the field; reduce it so the circuit accepts the fake leaf
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// --------------------------------------------------------------------------------------------- T5.1 ----
async function t51() {
  console.log("\n== T5.1 happy path (qualification tx)");
  const d = await deposit(key);
  console.log(`deposit ${d.saved.depositTx} leaf ${d.event.leafIndex}, note ${d.file}`);
  const recipient = fresh();
  check((await getBalance(recipient)) === 0n && (await rpc("eth_getTransactionCount", [recipient, "latest"])) === "0x0", "recipient is brand new (0 balance, nonce 0, never signs anything)", recipient);
  const w = await buildExitWithdrawTx(d.saved, recipient);
  console.log(`fee ${w.fee} wei (= ceil(MAX_COST bound ${w.maxCostBound} x 1.10)); MAX_COST of the final tx ${w.maxCost}`);
  const before = await exitBal();
  const a = logA(await settle(await submit("T5.1 withdrawal through TornadoExit", w.tx, "admit")));
  if (!a.receipt) return;
  const after = await exitBal();
  const cost = gasCost(a.receipt);
  const recBal = await getBalance(recipient);
  check(recBal === TORNADO.denomination - w.fee, "recipient balance == 1e17 - fee", `${recBal}`);
  check(await pool.isSpent(w.proof.nullifierHash), "isSpent(nullifierHash)");
  const ev = withdrawalEvent(a.receipt);
  check(!!ev && ev.relayer.toLowerCase() === EXIT.address.toLowerCase() && ev.to === recipient && ev.fee === w.fee, "Withdrawal event: relayer = TornadoExit, to = recipient, fee", ev ? JSON.stringify(ev, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "missing");
  check(after - before === w.fee - cost, "TornadoExit balance change == fee - actual gas cost", `${after - before} = ${w.fee} - ${cost} (gasUsed ${BigInt(a.receipt.gasUsed!)} x ${BigInt(a.receipt.effectiveGasPrice as Hex)})`);
  check(after >= before, "TornadoExit balance change >= 0");
  const adm = await admission(a.hash);
  const rep = await getReputation(EXIT.address);
  console.log(`INFO  admission: outcome ${adm?.outcome}, checks ${JSON.stringify(adm?.checks?.map((c: any) => `${c.rule}${c.entity ? "/" + c.entity : ""}:${c.verdict}`))}`);
  check(rep?.isStaked === true, "explorer shows TornadoExit as a staked entity", JSON.stringify(rep));
  console.log(`INFO  frames: ${JSON.stringify(a.receipt.frameReceipts?.map((f: any) => ({ status: f.status, gasUsed: BigInt(f.gasUsed).toString(), stateGasUsed: BigInt(f.stateGasUsed ?? 0).toString() })))}`);
  console.log(`QUALIFICATION TX: ${explorerTx(a.hash)}`);
  save("t51", { note: d.file, recipient, fee: w.fee, maxCost: w.maxCost, attempt: a, before, after, cost, adm, rep });
  await sweep(recipient);
}

// --------------------------------------------------------------------------------------------- T5.2 ----
async function t52() {
  console.log("\n== T5.2 negative admission (each must be rejected; TornadoExit balance unchanged)");
  const n = (await deposit(key)).saved;
  console.log(`negative-test note: ${n.commitment.slice(0, 14)}… (leaf ${n.leafIndex})`);
  const R = fresh();
  const { fee } = await quoteFee({ nullifierHash: n.nullifierHash, recipient: R });
  const good = await proveRaw(n, { recipient: R, fee });
  const goodData = withdrawCalldata(good);
  const base = { nullifierHash: good.nullifierHash, withdrawData: goodData };
  const sanity = await rpc("ethrex_simulateFrameTransaction", [encodeRaw(exitTx(base))], ETHREX_URL);
  check(sanity.frames?.every((f: any) => f.succeeded) === true, "sanity: the unmodified tx simulates fully successfully (so each rejection below is caused by its one change)");
  const before = await exitBal();
  const out: Record<string, Attempt> = {};
  const neg = async (id: string, label: string, tx: ReturnType<typeof exitTx>) => {
    out[id] = logA(await settle(await submit(`${id}) ${label}`, tx, "reject")));
  };

  await neg("a", "wrong relayer (proof + calldata relayer = operator)", exitTx({ ...base, withdrawData: withdrawCalldata(await proveRaw(n, { recipient: R, relayer: operator, fee })) }));
  await neg("b", "fee (1 wei) < MAX_COST", exitTx({ ...base, withdrawData: withdrawCalldata(await proveRaw(n, { recipient: R, fee: 1n })) }));
  await neg("c1", "refund = 1", exitTx({ ...base, withdrawData: withdrawCalldata(await proveRaw(n, { recipient: R, fee, refund: 1n })) }));
  await neg("c2", "SENDER value = 1 wei", exitTx({ ...base, value: 1n }));
  await neg("d", "unknown root (tree with an extra leaf the pool never saw)", exitTx({ ...base, withdrawData: withdrawCalldata(await (async () => {
    const events = await fetchDepositEvents();
    events.push({ commitment: numberToHex(BigInt(keccak256("0x1234")) % FIELD, { size: 32 }), leafIndex: events.length });
    return prove({ note: n.note, events, recipient: R, relayer: EXIT.address, fee });
  })()) }));

  // e1) T5.1's note (spent through TornadoExit): its key's seq is already 1.
  const t51 = results.t51 as any;
  if (t51?.note) {
    const spent = await loadNote(t51.note);
    const p = await proveRaw(spent, { recipient: R, fee });
    console.log(`INFO  e1 note: isSpent ${await pool.isSpent(spent.nullifierHash)}, NONCE_MANAGER seq(TornadoExit, key) = ${await seqOf(EXIT.address, keyFor(spent.nullifierHash))}`);
    await neg("e1", "already-spent nullifier (T5.1's note, spent through TornadoExit)", exitTx({ nullifierHash: p.nullifierHash, withdrawData: withdrawCalldata(p) }));
  }
  // e2) a note spent outside TornadoExit (S2 T2.6 legacy withdraw): seq still 0, so C9 isSpent is what rejects it.
  const files = fs.readdirSync(NOTES_DIR).filter((f) => f.startsWith("note-")).map((f) => path.join(NOTES_DIR, f));
  let e2Note: SavedNote | undefined;
  for (const f of files) {
    const s = await loadNote(f);
    if ((await pool.isSpent(s.nullifierHash)) && (await seqOf(EXIT.address, keyFor(s.nullifierHash))) === 0n) { e2Note = s; break; }
  }
  if (e2Note) {
    const p = await proveRaw(e2Note, { recipient: R, fee });
    await neg("e2", "already-spent nullifier (note spent by a legacy withdraw; keyed nonce unused)", exitTx({ nullifierHash: p.nullifierHash, withdrawData: withdrawCalldata(p) }));
  } else check(false, "e2: found a note spent outside TornadoExit");

  const flipped = (() => { const b = Buffer.from(good.proof.slice(2), "hex"); b[100] ^= 1; return ("0x" + b.toString("hex")) as Hex; })();
  await neg("f", "invalid proof (one byte flipped)", exitTx({ ...base, withdrawData: withdrawCalldata({ ...good, proof: flipped }) }));
  await neg("g", "valid proof for recipient R, calldata names another recipient", exitTx({ ...base, withdrawData: withdrawCalldata({ ...good, recipient: fresh() }) }));
  await neg("h1", "extra third frame", exitTx({ ...base, extraFrames: [senderFrame({ target: operator, execution: 30_000n })] }));
  await neg("h2", "SENDER target is not the pool", exitTx({ ...base, target: ADDR.TORNADO_VERIFIER }));
  await neg("h3", "wrong selector (0xdeadbeef, same length)", exitTx({ ...base, withdrawData: ("0xdeadbeef" + goodData.slice(10)) as Hex }));
  await neg("i", "nonce key != keyFor(nullifierHash)", exitTx({ ...base, nonceKeys: [keyFor(good.nullifierHash) ^ 1n] }));
  await neg("j", "nonceSeq = 1", exitTx({ ...base, nonceSeq: 1n }));
  await neg("k1", `SENDER execution gas ${MIN_WITHDRAW_EXEC_GAS - 1n} (< min)`, exitTx({ ...base, execGas: MIN_WITHDRAW_EXEC_GAS - 1n }));
  await neg("k2", `SENDER state gas ${MIN_WITHDRAW_STATE_GAS - 1n} (< min)`, exitTx({ ...base, stateGas: MIN_WITHDRAW_STATE_GAS - 1n }));
  const after = await exitBal();
  check(after === before, "TornadoExit balance unchanged across a)–k)", `${before} -> ${after}`);

  // l) (amended, ESCALATION 2) a contract recipient whose receive() reverts.
  console.log("\n-- T5.2 l) contract recipient (amended): admitted, frame 1 reverts, loss <= one tx, note's key consumed");
  const s3 = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, "s3-state.json"), "utf8"));
  const reverter: Address = s3.reverter;
  check((await getCode(reverter)) !== "0x", "RevertingReceiver has code", reverter);
  const L = (await deposit(key)).saved;
  const wl = await buildExitWithdrawTx(L, reverter, { allowContractRecipient: true });
  const kl = keyFor(wl.proof.nullifierHash);
  const seqBefore = await seqOf(EXIT.address, kl);
  const bl0 = await exitBal();
  const al = await settle(await submit("l) recipient = RevertingReceiver", wl.tx, "admit"));
  console.log(`INFO  l) ${al.outcome} ${al.hash}${al.receipt ? ` mined block ${BigInt(al.receipt.blockNumber)} frames ${JSON.stringify(al.receipt.frameReceipts?.map((f) => f.status))}` : ` ${al.error}`}`);
  const bl1 = await exitBal();
  const lcost = al.receipt ? gasCost(al.receipt) : 0n;
  check(al.outcome === "admitted" && al.receipt?.frameReceipts?.[0]?.status === "0x1" && al.receipt?.frameReceipts?.[1]?.status === "0x0", "l) admitted (no C6), frame 0 ok, frame 1 reverted");
  check(bl0 - bl1 === lcost, "l) TornadoExit loss == exactly that one tx's gas cost", `${bl0 - bl1} wei (max cost ${wl.maxCost})`);
  check(!(await pool.isSpent(wl.proof.nullifierHash)), "l) the note is not spent (withdraw reverted)");
  const seqAfter = await seqOf(EXIT.address, kl);
  check(seqBefore === 0n && seqAfter === 1n, "l) the note's keyed nonce was consumed", `${seqBefore} -> ${seqAfter}`);
  const retry = await buildExitWithdrawTx(L, fresh());
  const ar = logA(await settle(await submit("l) second attempt, same note, EOA recipient", retry.tx, "reject")));
  check((await exitBal()) === bl1, "l) TornadoExit balance unchanged by the second attempt");
  save("t52", { out, before, after, l: { attempt: al, loss: bl0 - bl1, seqBefore, seqAfter, retry: ar } });
  spare.push(n); // every a)–k) attempt was rejected: n is unspent and its key unused
  if (SWEEP) {
    // L can no longer go through TornadoExit, but its owner can still withdraw it the ordinary way.
    const p = await proveRaw(L, { recipient: operator, relayer: operator, fee: 0n });
    const { hash } = await sendLegacyAndWait(key, { to: ADDR.TORNADO_POOL, data: withdrawCalldata(p), gas: 3_000_000n });
    console.log(`INFO  e2e cleanup: note L withdrawn to the operator with a legacy tx (${hash})`);
  }
}

// --------------------------------------------------------------------------------------------- T5.3 ----
async function t53() {
  console.log("\n== T5.3 duplicate spend through the mempool (same note, two recipients)");
  const repBefore = await getReputation(EXIT.address);
  const d = (await deposit(key)).saved;
  const [r1, r2] = [fresh(), fresh()];
  const [w1, w2] = [await buildExitWithdrawTx(d, r1), await buildExitWithdrawTx(d, r2)];
  const a1 = await submit("tx1 -> recipient 1", w1.tx, "admit");
  const a2 = await submit("tx2 -> recipient 2 (same note, same slot, same fee)", w2.tx, "reject");
  console.log(`INFO  tx1 ${a1.outcome}${a1.error ? ": " + a1.error : ""}`);
  console.log(`INFO  tx2 ${a2.outcome}${a2.error ? ": " + a2.error : ""}`);
  const s1 = await settle(a1);
  const s2 = await settle(a2);
  console.log(report(s1));
  console.log(report(s2));
  if (!s1.pass) failures++;
  if (!s2.pass) failures++;
  const included = [s1, s2].filter((a) => a.receipt).length;
  check(included <= 1, "at most one included", String(included));
  const [b1, b2] = [await getBalance(r1), await getBalance(r2)];
  console.log(`INFO  recipient 1 balance ${b1}, recipient 2 balance ${b2} (the second note-holder attempt was refused at submission and costs nothing)`);
  const rep = await getReputation(EXIT.address);
  check(rep?.status === "ok", "TornadoExit reputation stays ACTIVE (status ok)", JSON.stringify(rep));
  console.log(`INFO  reputation counters before ${JSON.stringify({ seen: repBefore?.opsSeen, included: repBefore?.opsIncluded })} after ${JSON.stringify({ seen: rep?.opsSeen, included: rep?.opsIncluded })}`);
  save("t53", { s1, s2, b1, b2, repBefore, rep });
  await sweep(r1);
}

// --------------------------------------------------------------------------------------------- T5.4 ----
async function t54() {
  console.log("\n== T5.4 canonical mempool (ethrex eth_sendRawTransaction) rejects the same tx");
  const d = await nextNote();
  const w = await buildExitWithdrawTx(d, fresh());
  let msg = "";
  try {
    const h = await rpc("eth_sendRawTransaction", [encodeRaw(w.tx)], ETHREX_URL);
    msg = `ACCEPTED ${h}`;
  } catch (e) {
    msg = (e as Error).message;
  }
  check(!msg.startsWith("ACCEPTED"), "ethrex rejected the raw 0x06 tx", msg);
  const sim = await rpc("ethrex_simulateFrameTransaction", [encodeRaw(w.tx)], ETHREX_URL);
  console.log(`INFO  ethrex_simulateFrameTransaction: canonicalMempoolValid ${sim.canonicalMempoolValid}, violation ${sim.canonicalMempoolViolation}`);
  check(!(await pool.isSpent(w.proof.nullifierHash)), "the note stays unspent (reusable)");
  save("t54", { note: d, msg, sim: { canonicalMempoolValid: sim.canonicalMempoolValid, canonicalMempoolViolation: sim.canonicalMempoolViolation } });
  spare.unshift(d);
}

// --------------------------------------------------------------------------------------------- T5.5 ----
const U_STATE = path.join(NOTES_DIR, "s5-unstaked.json");
async function unstakedExit(forceNew = false): Promise<Address> {
  if (!forceNew && fs.existsSync(U_STATE)) {
    const a = JSON.parse(fs.readFileSync(U_STATE, "utf8")).address;
    if ((await getCode(a)) !== "0x") return a;
  }
  const args = [ADDR.TORNADO_POOL, EXIT.verifier, ADDR.STAKING_REGISTRY, MIN_WITHDRAW_EXEC_GAS, MIN_WITHDRAW_STATE_GAS, operator];
  const d = await deploy(key, "TornadoExit", args, 50_000_000_000_000_000n);
  console.log(`deployed unstaked TornadoExit ${d.address} tx ${d.hash}`);
  fs.writeFileSync(U_STATE, JSON.stringify({ address: d.address, deployTx: d.hash }, null, 2) + "\n");
  return d.address;
}
async function t55() {
  console.log("\n== T5.5 stake is necessary (unstaked TornadoExit, same constructor params)");
  const u = await unstakedExit(FRESH_UNSTAKED);
  const info = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [u] });
  check(info[0] === 0n, "the second instance has no stake", String(info));
  const d = spare[0] ?? (await deposit(key)).saved; // not consumed by a rejection
  const w = await buildExitWithdrawTx(d, fresh(), { exit: u });
  const a = logA(await settle(await submit("valid withdrawal through the unstaked instance", w.tx, "reject")));
  save("t55", { unstaked: u, attempt: a, adm: await admission(a.hash) });
  if (SWEEP && FRESH_UNSTAKED) {
    const bal = await getBalance(u);
    await sendLegacyAndWait(key, { to: u, gas: 200_000n, data: encodeFunctionData({ abi: exitAbi, functionName: "withdrawFunds", args: [operator, bal] }) });
    console.log(`INFO  e2e cleanup: recovered the unstaked instance's float (${bal} wei)`);
  }
}

// --------------------------------------------------------------------------------------------- T5.6 ----
async function t56() {
  console.log("\n== T5.6 fee accounting over 3 consecutive withdrawals");
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const d = await nextNote();
    const r = fresh();
    const w = await buildExitWithdrawTx(d, r);
    const before = await exitBal();
    const a = await settle(await submit(`withdrawal ${i + 1}`, w.tx, "admit"));
    console.log(report(a));
    if (!a.pass) failures++;
    const after = await exitBal();
    const cost = a.receipt ? gasCost(a.receipt) : 0n;
    check(after >= before, `withdrawal ${i + 1}: TornadoExit net balance did not decrease`, `${before} -> ${after} (fee ${w.fee}, gas ${cost}, net +${after - before})`);
    rows.push({ hash: a.hash, fee: w.fee, cost, before, after });
    await sweep(r);
  }
  save("t56", rows);
}

// --------------------------------------------------------------------------------------------- T5.7 ----
async function t57() {
  console.log("\n== T5.7 plain ETH transfer to TornadoExit");
  const before = await exitBal();
  const { hash, receipt } = await sendLegacyAndWait(key, { to: EXIT.address, value: 10n ** 15n, gas: 100_000n });
  const after = await exitBal();
  check(receipt.status === "0x1" && after - before === 10n ** 15n, "transfer succeeded (receive())", `tx ${hash}, +${after - before}`);
  const trace = await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }], ETHREX_URL);
  const calls = trace?.calls ?? [];
  check(calls.length === 0, "no inner call (in particular no DELEGATECALL to the APPROVE helper)", `${calls.length} inner calls; gasUsed ${BigInt(receipt.gasUsed)}`);
  save("t57", { hash, before, after, calls });
}

// --------------------------------------------------------------------------------------------- T5.8 ----
async function t58() {
  console.log("\n== T5.8 owner functions");
  const strangerKey = generatePrivateKey();
  const stranger = privateKeyToAccount(strangerKey).address;
  await sendLegacyAndWait(key, { to: stranger, value: 5n * 10n ** 15n, gas: 250_000n });
  const calls: [string, Hex, bigint][] = [
    ["stake()", encodeFunctionData({ abi: exitAbi, functionName: "stake", args: [] }), STAKE.amount],
    ["unlockStake()", encodeFunctionData({ abi: exitAbi, functionName: "unlockStake", args: [] }), 0n],
    ["withdrawStake(stranger)", encodeFunctionData({ abi: exitAbi, functionName: "withdrawStake", args: [stranger] }), 0n],
    ["withdrawFunds(stranger, 1)", encodeFunctionData({ abi: exitAbi, functionName: "withdrawFunds", args: [stranger, 1n] }), 0n],
  ];
  const out: any[] = [];
  for (const [label, data, value] of calls) {
    const hash = await sendLegacy(strangerKey, { to: EXIT.address, data, value: value > 0n ? 10n ** 14n : 0n, gas: 300_000n });
    const r = await waitReceipt(hash);
    check(r.status === "0x0", `non-owner ${label} on the live instance reverts`, `tx ${hash}`);
    out.push({ label, hash, status: r.status });
  }
  const info = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [EXIT.address] });
  check(info[0] >= STAKE.amount && info[2] === 0n, "live instance still staked, not unlocking", String(info));
  // Owner path on the T5.5 instance: stake, then unlockStake.
  const u = await unstakedExit();
  const st = await sendLegacyAndWait(key, { to: u, value: STAKE.amount, gas: 500_000n, data: encodeFunctionData({ abi: exitAbi, functionName: "stake", args: [] }) });
  const i1 = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [u] });
  check(i1[0] === STAKE.amount && i1[2] === 0n, "owner stake() on the T5.5 instance", `tx ${st.hash}: ${i1}`);
  const ul = await sendLegacyAndWait(key, { to: u, gas: 300_000n, data: encodeFunctionData({ abi: exitAbi, functionName: "unlockStake", args: [] }) });
  const i2 = await client.readContract({ address: ADDR.STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [u] });
  check(i2[2] > 0n, "owner unlockStake() on the T5.5 instance sets withdrawTime", `tx ${ul.hash}: ${i2}`);
  save("t58", { stranger, out, live: info, unstaked: { address: u, stake: st.hash, unlock: ul.hash, after: i2 } });
}

const steps: Record<string, () => Promise<void>> = { t51, t52, t53, t54, t55, t56, t57, t58 };
const which = process.argv.slice(2);
for (const s of which.length === 0 || which.includes("all") ? Object.keys(steps) : which) await steps[s]();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall selected S5 checks passed");
process.exit(failures ? 1 : 0);
