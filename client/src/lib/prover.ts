// Bridge to prover/cli.js, which runs on Node 16 with the legacy Tornado stack (see prover/package.json).
import { spawn } from "node:child_process";
import path from "node:path";
import type { Address, Hex } from "viem";
import "./env.js";
import { REPO_ROOT } from "./localState.js";

const PROVER_CLI = path.join(REPO_ROOT, "prover", "cli.js");
const proverNode = () => process.env.PROVER_NODE ?? "node";

function callProver<T>(req: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(proverNode(), [PROVER_CLI], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`prover ${req.cmd} failed (exit ${code}): ${err.trim()}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`prover ${req.cmd}: bad output: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}

export interface DepositEvent {
  commitment: Hex;
  leafIndex: number;
  blockNumber?: bigint;
  txHash?: Hex;
}

export interface NoteInfo {
  note: string;
  commitment: Hex;
  nullifierHash: Hex;
}

export interface WithdrawProof {
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Address;
  relayer: Address;
  fee: Hex;
  refund: Hex;
  leafIndex: number;
  proveMs: number;
}

export const newNote = (): Promise<NoteInfo> => callProver({ cmd: "newNote", netId: 1337 });
export const parseNote = (note: string): Promise<Omit<NoteInfo, "note">> => callProver({ cmd: "parseNote", note });
export const computeRoot = async (events: DepositEvent[]): Promise<Hex> =>
  (await callProver<{ root: Hex }>({ cmd: "computeRoot", events: events.map((e) => ({ commitment: e.commitment, leafIndex: e.leafIndex })) })).root;

export const prove = (a: { note: string; events: DepositEvent[]; recipient: Address; relayer: Address; fee: bigint; refund?: bigint }): Promise<WithdrawProof> =>
  callProver({
    cmd: "prove", note: a.note, recipient: a.recipient, relayer: a.relayer, fee: a.fee.toString(), refund: (a.refund ?? 0n).toString(),
    events: a.events.map((e) => ({ commitment: e.commitment, leafIndex: e.leafIndex })),
  });
