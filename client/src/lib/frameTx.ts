// EIP-8141 frame transactions for this devnet, via @forshtat/hegota-support (approach reused from the MIT-licensed
// forshtat/mempool-workshop src/lib/frameTx/*).
import type { Address, Hex } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";
import * as lib from "@forshtat/hegota-support/tx";
import { ETHREX_URL, RPC_URL } from "../config.js";
import { rpc, sleep } from "./rpc.js";

export type { Frame, FrameTx, SignatureEntry } from "@forshtat/hegota-support/tx";
export const profile = getProfile("ethrex-eip8141-tracer");
export const FRAME_MODE = profile.frameModes as { DEFAULT: number; VERIFY: number; SENDER: number };
export const ATOMIC_BATCH_FLAG = (profile as any).flagBits.ATOMIC_BATCH as number;

export interface FrameOpts {
  scope?: "PAYMENT" | "EXECUTION" | "EXECUTION_AND_PAYMENT";
  target?: Address | null;
  execution: bigint;
  state?: bigint;
  value?: bigint;
  data?: Hex;
  flags?: number;
}

export const verifyFrame = (o: FrameOpts): lib.Frame => lib.frame(profile, "VERIFY", { ...o, target: o.target ?? null });
export const senderFrame = (o: Omit<FrameOpts, "scope">): lib.Frame => lib.frame(profile, "SENDER", { ...o, target: o.target ?? null });

export const secp256k1Placeholder = (signer: Hex = "0x") => lib.secp256k1Placeholder(profile, signer);
/** An ARBITRARY (scheme 0) signature entry: not validated by the protocol. */
export const arbitrarySignature = (signature: Hex = "0x"): lib.SignatureEntry => ({ scheme: profile.sigSchemes.ARBITRARY, signer: "0x", msg: "0x", signature });

export function newTx(f: {
  sender: Address; nonceSeq: bigint; nonceKeys?: bigint[]; frames: lib.Frame[]; signatures: lib.SignatureEntry[];
  maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint; chainId: number;
}): lib.FrameTx {
  return lib.newTx({
    chainId: f.chainId, sender: f.sender, nonceSeq: f.nonceSeq, nonceKeys: f.nonceKeys, frames: f.frames,
    signatures: f.signatures, fees: { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas },
  });
}

export const signTx = (tx: lib.FrameTx, key: Hex) => lib.signTx(profile, tx, key);
export const txHash = (tx: lib.FrameTx): Hex => lib.txHash(profile, tx);
export const sigHash = (tx: lib.FrameTx): Hex => lib.sigHash(profile, tx);
export const encodeRaw = (tx: lib.FrameTx): Hex => lib.encodeTx(profile, tx);
export { toWire };

/** Submits to the standard alt-mempool (sidecar `eth_sendFrameTransaction`). */
export const sendFrameTx = (tx: lib.FrameTx, url: string = RPC_URL): Promise<Hex> => rpc("eth_sendFrameTransaction", [toWire(tx)], url);
/** Submits the raw 0x06 bytes to ethrex's canonical mempool (`eth_sendRawTransaction`). */
export const sendRawToCanonical = (tx: lib.FrameTx, url: string = ETHREX_URL): Promise<Hex> => rpc("eth_sendRawTransaction", [encodeRaw(tx)], url);

export interface FrameReceipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed?: Hex;
  frameReceipts?: { status: Hex; gasUsed?: Hex; [k: string]: unknown }[];
  [k: string]: unknown;
}

export async function waitFrameReceipt(hash: Hex, timeoutMs = 120_000): Promise<FrameReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(2000);
  }
  throw new Error(`frame tx ${hash} not mined within ${timeoutMs / 1000}s`);
}

/** True when the tx and every frame succeeded. */
export const allFramesOk = (r: FrameReceipt) => r.status === "0x1" && (r.frameReceipts ?? []).length > 0 && r.frameReceipts!.every((f) => f.status === "0x1");

/** The sidecar's rule-by-rule admission report and lifecycle for a hash it saw. */
export const explorerTxDetail = (hash: Hex): Promise<any> => rpc("skandha_explorer_getTransaction", [hash]);

/** The sidecar's reputation entry for an address (walks the paginated list). */
export async function getReputation(address: Address): Promise<any | null> {
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const p = await rpc("skandha_explorer_listReputation", [{ limit: 200, ...(cursor ? { cursor } : {}) }]);
    const hit = p.items.find((e: any) => e.address.toLowerCase() === address.toLowerCase());
    if (hit) return hit;
    if (!p.nextCursor) return null;
    cursor = p.nextCursor;
  }
  return null;
}
