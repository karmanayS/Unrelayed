// Submits a frame tx to the sidecar and records whether it was admitted (and later mined with every frame ok) or
// rejected (with the node's message). Used by the S3/S4/S5 acceptance tests.
import { decodeErrorResult, parseAbi, type Hex } from "viem";
import { allFramesOk, explorerTxDetail, sendFrameTx, txHash, waitFrameReceipt, type FrameReceipt, type FrameTx } from "./frameTx.js";

export interface Attempt {
  label: string;
  expect: "admit" | "reject";
  outcome: "admitted" | "rejected";
  hash: Hex;
  error?: string;
  receipt?: FrameReceipt;
  minedOk?: boolean;
  pass?: boolean;
}

export async function submit(label: string, tx: FrameTx, expect: "admit" | "reject"): Promise<Attempt> {
  const hash = txHash(tx);
  try {
    const got = await sendFrameTx(tx);
    if (got.toLowerCase() !== hash.toLowerCase()) throw new Error(`node returned hash ${got}, local ${hash}`);
    return { label, expect, outcome: "admitted", hash };
  } catch (e) {
    const msg = (e as Error).message;
    if (/node returned hash/.test(msg)) throw e;
    return { label, expect, outcome: "rejected", hash, error: msg };
  }
}

/** Waits for an admitted attempt's receipt; pass = outcome matched expectation (and, if admitted, every frame ok). */
export async function settle(a: Attempt): Promise<Attempt> {
  if (a.outcome === "admitted") {
    a.receipt = await waitFrameReceipt(a.hash);
    a.minedOk = allFramesOk(a.receipt);
  }
  a.pass = a.expect === "admit" ? a.outcome === "admitted" && a.minedOk === true : a.outcome === "rejected";
  return a;
}

const ERRORS = parseAbi(["error Error(string)", "error PairingAddFailed()", "error PairingMulFailed()", "error PairingOpcodeFailed()", "error NotOwner()", "error NoFallback()"]);

/** Appends the decoded revert reason to a node message that carries "reverted with data 0x…". */
export function explain(msg: string | undefined): string {
  const m = msg?.match(/reverted with data (0x[0-9a-fA-F]+)/);
  if (!m) return msg ?? "";
  try {
    const d = decodeErrorResult({ abi: ERRORS, data: m[1] as Hex });
    return `${msg!.replace(m[1], m[1].slice(0, 10) + "…")} => ${d.errorName === "Error" ? JSON.stringify(d.args?.[0]) : d.errorName + "()"}`;
  } catch {
    return msg!;
  }
}

export function report(a: Attempt): string {
  const tag = a.pass ? "PASS" : "FAIL";
  const detail = a.outcome === "admitted"
    ? `admitted ${a.hash}${a.receipt ? ` mined block ${BigInt(a.receipt.blockNumber)} frames ${JSON.stringify((a.receipt.frameReceipts ?? []).map((f) => f.status))}` : ""}`
    : `rejected: ${explain(a.error)}`;
  return `${tag}  [expect ${a.expect}] ${a.label}: ${detail}`;
}

export const admission = async (hash: Hex) => {
  try {
    return (await explorerTxDetail(hash))?.admission ?? null;
  } catch {
    return null;
  }
};
