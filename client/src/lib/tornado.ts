// Tornado pool reads, Deposit-event tree source, deposits, and note files.
import fs from "node:fs";
import path from "node:path";
import { decodeEventLog, encodeFunctionData, getAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { ADDR, TORNADO } from "../config.js";
import { tornadoAbi } from "./abis.js";
import { sendLegacyAndWait } from "./legacy.js";
import { REPO_ROOT } from "./localState.js";
import { computeRoot, newNote, parseNote, prove, type DepositEvent, type NoteInfo, type WithdrawProof } from "./prover.js";
import { client, rpc } from "./rpc.js";

export const NOTES_DIR = path.join(REPO_ROOT, "notes");
const DEPOSIT_TOPIC = toEventSelector(getAbiItem({ abi: tornadoAbi, name: "Deposit" }));

export const pool = {
  nextIndex: async () => Number(await client.readContract({ address: ADDR.TORNADO_POOL, abi: tornadoAbi, functionName: "nextIndex" })),
  getLastRoot: () => client.readContract({ address: ADDR.TORNADO_POOL, abi: tornadoAbi, functionName: "getLastRoot" }),
  isKnownRoot: (root: Hex) => client.readContract({ address: ADDR.TORNADO_POOL, abi: tornadoAbi, functionName: "isKnownRoot", args: [root] }),
  isSpent: (n: Hex) => client.readContract({ address: ADDR.TORNADO_POOL, abi: tornadoAbi, functionName: "isSpent", args: [n] }),
};

/** Every Deposit event of the pool, via plain eth_getLogs (tornado-cli rebuilt the tree the same way). */
export async function fetchDepositEvents(): Promise<DepositEvent[]> {
  const logs: any[] = await rpc("eth_getLogs", [{ address: ADDR.TORNADO_POOL, topics: [DEPOSIT_TOPIC], fromBlock: "0x0", toBlock: "latest" }]);
  return logs
    .map((l) => {
      const d = decodeEventLog({ abi: tornadoAbi, eventName: "Deposit", data: l.data, topics: l.topics });
      return { commitment: d.args.commitment, leafIndex: Number(d.args.leafIndex), blockNumber: BigInt(l.blockNumber), txHash: l.transactionHash };
    })
    .sort((a, b) => a.leafIndex - b.leafIndex);
}

/** Rebuilds the tree from events and checks it against the pool (tornado-cli generateMerkleProof's asserts). */
export async function checkedEvents(nullifierHash?: Hex): Promise<{ events: DepositEvent[]; root: Hex }> {
  const events = await fetchDepositEvents();
  events.forEach((e, i) => {
    if (e.leafIndex !== i) throw new Error(`Deposit events have a gap at leaf ${i}`);
  });
  const root = await computeRoot(events);
  if (!(await pool.isKnownRoot(root))) throw new Error(`Merkle tree is corrupted: computed root ${root} is not known to the pool`);
  if (nullifierHash && (await pool.isSpent(nullifierHash))) throw new Error("The note is already spent");
  return { events, root };
}

// ---------------------------------------------------------------------------------------------- note files ----

export interface SavedNote extends NoteInfo {
  depositTx?: Hex;
  leafIndex?: number;
  createdAt: string;
}

export function saveNote(n: SavedNote): string {
  fs.mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(NOTES_DIR, `note-${n.commitment.slice(2, 14)}.json`);
  fs.writeFileSync(file, JSON.stringify(n, null, 2) + "\n", { mode: 0o600 });
  return file;
}

/** Accepts a note string or a path to a saved note file. */
export async function loadNote(noteOrFile: string): Promise<SavedNote> {
  if (/^tornado-/.test(noteOrFile.trim())) {
    const note = noteOrFile.trim();
    return { note, ...(await parseNote(note)), createdAt: "" };
  }
  const j = JSON.parse(fs.readFileSync(noteOrFile, "utf8")) as SavedNote;
  const parsed = await parseNote(j.note);
  if (parsed.commitment !== j.commitment) throw new Error(`note file ${noteOrFile}: commitment does not match the note`);
  return j;
}

// ------------------------------------------------------------------------------------------------ deposit ----

/** Creates a note and deposits it with 0.1 ETH from `key` (a legacy tx). Saves the note under notes/. */
export async function deposit(key: Hex): Promise<{ saved: SavedNote; file: string; nextIndexBefore: number; receipt: any; event: DepositEvent }> {
  const info = await newNote();
  const nextIndexBefore = await pool.nextIndex();
  // Save before sending, so a crash after the tx can never lose the note.
  let saved: SavedNote = { ...info, createdAt: new Date().toISOString() };
  let file = saveNote(saved);
  const data = encodeFunctionData({ abi: tornadoAbi, functionName: "deposit", args: [info.commitment] });
  const { hash, receipt } = await sendLegacyAndWait(key, { to: ADDR.TORNADO_POOL, value: TORNADO.denomination, data, gas: 2_000_000n });
  const log = receipt.logs.find((l: any) => l.address.toLowerCase() === ADDR.TORNADO_POOL.toLowerCase() && l.topics[0] === DEPOSIT_TOPIC);
  if (!log) throw new Error(`deposit ${hash}: no Deposit event`);
  const d = decodeEventLog({ abi: tornadoAbi, eventName: "Deposit", data: log.data, topics: log.topics });
  const event: DepositEvent = { commitment: d.args.commitment, leafIndex: Number(d.args.leafIndex), blockNumber: BigInt(receipt.blockNumber), txHash: hash };
  saved = { ...saved, depositTx: hash, leafIndex: event.leafIndex };
  file = saveNote(saved);
  return { saved, file, nextIndexBefore, receipt, event };
}

/** Rebuilds the tree from chain events, checks it, and proves a withdrawal of `note`. */
export async function proveWithdrawal(a: { note: string; nullifierHash: Hex; recipient: Address; relayer: Address; fee: bigint; refund?: bigint }): Promise<WithdrawProof> {
  const { events } = await checkedEvents(a.nullifierHash);
  return prove({ note: a.note, events, recipient: a.recipient, relayer: a.relayer, fee: a.fee, refund: a.refund });
}

/** Calldata of pool.withdraw for a proof. */
export const withdrawCalldata = (p: Pick<WithdrawProof, "proof" | "root" | "nullifierHash" | "recipient" | "relayer" | "fee" | "refund">): Hex =>
  encodeFunctionData({
    abi: tornadoAbi, functionName: "withdraw",
    args: [p.proof, p.root, p.nullifierHash, p.recipient, p.relayer, BigInt(p.fee), BigInt(p.refund)],
  });

/** The 6 public inputs in verifier order. */
export const publicInputs = (p: Pick<WithdrawProof, "root" | "nullifierHash" | "recipient" | "relayer" | "fee" | "refund">): readonly [bigint, bigint, bigint, bigint, bigint, bigint] =>
  [BigInt(p.root), BigInt(p.nullifierHash), BigInt(p.recipient), BigInt(p.relayer), BigInt(p.fee), BigInt(p.refund)] as const;
