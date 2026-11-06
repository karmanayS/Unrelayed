// yarn cli <deposit | withdraw | status> (BUILD-PLAN §S6).
//   yarn cli deposit                                   deposit 0.1 ETH from the operator key; prints + saves the note
//   yarn cli withdraw --note <note|file> [--to <addr>] relayer-free withdrawal through TornadoExit (no funded key)
//   yarn cli status --note <note|file>                 deposited? spent? leaf index? TornadoExit slot used?
import { parseArgs } from "node:util";
import { concat, keccak256, numberToHex, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, explorerTx, TORNADO } from "./config.js";
import { EXIT } from "./deployments.js";
import { explain } from "./lib/attempt.js";
import { buildExitWithdrawTx, keyFor } from "./lib/exit.js";
import { sendFrameTx, waitFrameReceipt } from "./lib/frameTx.js";
import { getBalance, rpc } from "./lib/rpc.js";
import { fetchDepositEvents, loadNote, pool } from "./lib/tornado.js";

const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;
const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { note: { type: "string" }, to: { type: "string" } } });

async function depositCmd() {
  const { operatorKey } = await import("./lib/env.js");
  const { deposit } = await import("./lib/tornado.js");
  const r = await deposit(operatorKey());
  console.log(`deposited 0.1 ETH: tx ${r.saved.depositTx} (leaf ${r.event.leafIndex})`);
  console.log(`explorer: ${explorerTx(r.saved.depositTx!)}`);
  console.log(`note saved to ${r.file}`);
  console.log(`\nYOUR NOTE (keep it secret, it is the money):\n${r.saved.note}\n`);
}

async function withdrawCmd() {
  // The withdrawal uses no funded key at all: drop the operator key from this process so any use would throw.
  delete process.env.OPERATOR_PRIVATE_KEY;
  if (!values.note) throw new Error("--note <note|file> is required");
  const note = await loadNote(values.note);
  let to = values.to as Address | undefined;
  if (!to) {
    const k = generatePrivateKey();
    to = privateKeyToAccount(k).address;
    console.log(`no --to given: generated a brand-new recipient ${to}`);
    console.log(`  its private key (shown once, only here): ${k}`);
  }
  console.log(`TornadoExit (staked shared sender, pays the gas, reimbursed by the Tornado fee): ${EXIT.address}`);
  console.log(`recipient balance before: ${eth(await getBalance(to))}`);
  console.log("rebuilding the Merkle tree from Deposit events and generating the proof locally…");
  const w = await buildExitWithdrawTx(note, to);
  console.log(`proof ready in ${(w.proof.proveMs / 1000).toFixed(1)} s; fee ${eth(w.fee)} (worst-case gas ${eth(w.maxCost)} + 10 %)`);
  console.log("submitting the frame transaction to the ERC-8421 alt mempool (eth_sendFrameTransaction)…");
  let hash: Hex;
  try {
    hash = await sendFrameTx(w.tx);
  } catch (e) {
    throw new Error(`rejected by the alt mempool: ${explain((e as Error).message)}`);
  }
  console.log(`admitted: ${hash}`);
  const r = await waitFrameReceipt(hash);
  const ok = r.status === "0x1" && (r.frameReceipts ?? []).every((f) => f.status === "0x1");
  console.log(`mined in block ${BigInt(r.blockNumber)}: ${ok ? "every frame succeeded" : `FAILED frames ${JSON.stringify(r.frameReceipts?.map((f) => f.status))}`}`);
  console.log(`recipient balance after:  ${eth(await getBalance(to))} (= 0.1 ETH - fee ${eth(w.fee)})`);
  console.log(`explorer: ${explorerTx(hash)}`);
  if (!ok) process.exitCode = 1;
}

async function statusCmd() {
  if (!values.note) throw new Error("--note <note|file> is required");
  const note = await loadNote(values.note);
  const ev = (await fetchDepositEvents()).find((e) => e.commitment.toLowerCase() === note.commitment.toLowerCase());
  const slot = keccak256(concat([pad(EXIT.address, { size: 32 }), numberToHex(keyFor(note.nullifierHash), { size: 32 })]));
  const seq = BigInt(await rpc("eth_getStorageAt", [ADDR.NONCE_MANAGER, slot, "latest"]));
  console.log(`commitment     ${note.commitment}`);
  console.log(`nullifierHash  ${note.nullifierHash}`);
  console.log(`deposited      ${ev ? `yes, leaf ${ev.leafIndex}, tx ${ev.txHash}` : "no"}`);
  console.log(`spent          ${(await pool.isSpent(note.nullifierHash)) ? "yes" : "no"}`);
  console.log(`TornadoExit    ${seq === 0n ? "slot unused (can withdraw through TornadoExit)" : "slot used (a TornadoExit withdrawal for this note was already included)"}`);
  console.log(`pool           ${ADDR.TORNADO_POOL} (denomination ${eth(TORNADO.denomination)})`);
}

const cmds: Record<string, () => Promise<void>> = { deposit: depositCmd, withdraw: withdrawCmd, status: statusCmd };
if (!cmd || !cmds[cmd]) {
  console.error("usage: yarn cli deposit | withdraw --note <note|file> [--to <address>] | status --note <note|file>");
  process.exit(2);
}
cmds[cmd]().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
