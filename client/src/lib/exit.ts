// The TornadoExit withdrawal transaction (BUILD-PLAN §2.2) and its builder buildExitWithdrawTx (§S5 task 3).
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { ADDR, CHAIN_ID, ETHREX_URL, FRAME_MAX_FEE_PER_GAS } from "../config.js";
import { EXIT } from "../deployments.js";
import { loadArtifact } from "./deploy.js";
import { encodeRaw, newTx, senderFrame, verifyFrame, type Frame, type FrameTx } from "./frameTx.js";
import type { WithdrawProof } from "./prover.js";
import { rpc } from "./rpc.js";
import { proveWithdrawal, withdrawCalldata } from "./tornado.js";

export const exitAbi = loadArtifact("TornadoExit").abi;
/** Gas limit of the VERIFY frame (measured ≈ 300k incl. the 261k proof check; staked budget 1,000,000). */
export const EXIT_VERIFY_GAS = 450_000n;
/** BUILD-PLAN §S2 T2.6: 25 % over the minimum successful frame-1 limits (PROGRESS.md ESCALATION 3). */
export const MIN_WITHDRAW_EXEC_GAS = 603_000n; // ceil(481,627 minimum successful limit × 1.25), ESCALATION 3
export const MIN_WITHDRAW_STATE_GAS = 352_000n;
/** PRE-APPROVED (T3.2): the devnet accepts 256-bit nonce keys, so the key is the nullifier hash itself. */
export const keyFor = (nullifierHash: Hex): bigint => BigInt(nullifierHash);
/** fee = ceil(MAX_COST × 1.10) */
export const FEE_MARGIN_BPS = 11_000n;

export const verifyWithdrawalData = (): Hex => encodeFunctionData({ abi: exitAbi, functionName: "verifyWithdrawal", args: [] });

export interface ExitTxOpts {
  exit?: Address;
  nullifierHash: Hex;
  withdrawData: Hex;
  // Overrides, used only by the negative tests (T5.2):
  nonceKeys?: bigint[];
  nonceSeq?: bigint;
  verifyGas?: bigint;
  execGas?: bigint;
  stateGas?: bigint;
  value?: bigint;
  target?: Address;
  extraFrames?: Frame[];
  maxFeePerGas?: bigint;
}

/** The only shape TornadoExit approves: [VERIFY(self, verifyWithdrawal()), SENDER(pool.withdraw(…))]. */
export function exitTx(o: ExitTxOpts): FrameTx {
  return newTx({
    chainId: CHAIN_ID,
    sender: o.exit ?? EXIT.address,
    nonceKeys: o.nonceKeys ?? [keyFor(o.nullifierHash)],
    nonceSeq: o.nonceSeq ?? 0n,
    signatures: [], // T3.1: a contract sender needs no signature entry
    maxFeePerGas: o.maxFeePerGas ?? FRAME_MAX_FEE_PER_GAS,
    frames: [
      verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: o.verifyGas ?? EXIT_VERIFY_GAS, data: verifyWithdrawalData() }),
      senderFrame({ target: o.target ?? ADDR.TORNADO_POOL, value: o.value ?? 0n, execution: o.execGas ?? MIN_WITHDRAW_EXEC_GAS, state: o.stateGas ?? MIN_WITHDRAW_STATE_GAS, data: o.withdrawData }),
      ...(o.extraFrames ?? []),
    ],
  });
}

/** ethrex's maximum cost of a tx (= TXPARAM MAX_COST, T3.7), from ethrex_simulateFrameTransaction. */
export async function maxCostOf(tx: FrameTx): Promise<bigint> {
  const sim = await rpc("ethrex_simulateFrameTransaction", [encodeRaw(tx)], ETHREX_URL);
  if (!sim?.maxCost) throw new Error(`ethrex_simulateFrameTransaction returned no maxCost: ${JSON.stringify(sim).slice(0, 300)}`);
  return BigInt(sim.maxCost);
}

/**
 * The fee to prove with, before the proof exists: MAX_COST of the same tx shape with every unknown calldata byte
 * non-zero (an upper bound on calldata gas, so the real tx's MAX_COST can only be lower), times 1.10, rounded up.
 */
export async function quoteFee(a: { exit?: Address; nullifierHash: Hex; recipient: Address }): Promise<{ fee: bigint; maxCostBound: bigint }> {
  const filler = ("0x" + "11".repeat(32)) as Hex;
  const dummy = withdrawCalldata({
    proof: ("0x" + "11".repeat(256)) as Hex, root: filler, nullifierHash: a.nullifierHash, recipient: a.recipient,
    relayer: a.exit ?? EXIT.address, fee: filler, refund: "0x0",
  });
  const maxCostBound = await maxCostOf(exitTx({ exit: a.exit, nullifierHash: a.nullifierHash, withdrawData: dummy }));
  return { fee: (maxCostBound * FEE_MARGIN_BPS + 9_999n) / 10_000n, maxCostBound };
}

export interface ExitWithdrawal {
  tx: FrameTx;
  proof: WithdrawProof;
  fee: bigint;
  maxCostBound: bigint;
  maxCost: bigint;
}

/**
 * buildExitWithdrawTx(note, recipient): rebuilds the tree from chain events, proves with relayer = TornadoExit and
 * fee = ceil(MAX_COST × 1.10), and builds the §2.2 frame tx. Throws (before anything is sent) if the recipient has
 * code: a reverting recipient would burn the note's one TornadoExit attempt (ESCALATION 2).
 */
export async function buildExitWithdrawTx(note: { note: string; nullifierHash: Hex }, recipient: Address, o: { exit?: Address; allowContractRecipient?: boolean } = {}): Promise<ExitWithdrawal> {
  const exit = o.exit ?? EXIT.address;
  if (!o.allowContractRecipient && (await rpc("eth_getCode", [recipient, "latest"])) !== "0x") {
    throw new Error(`recipient ${recipient} has code; withdraw to a plain address (an EOA you control)`);
  }
  const { fee, maxCostBound } = await quoteFee({ exit, nullifierHash: note.nullifierHash, recipient });
  const proof = await proveWithdrawal({ note: note.note, nullifierHash: note.nullifierHash, recipient, relayer: exit, fee });
  const tx = exitTx({ exit, nullifierHash: proof.nullifierHash, withdrawData: withdrawCalldata(proof) });
  const maxCost = await maxCostOf(tx);
  if (fee < maxCost) throw new Error(`fee ${fee} < MAX_COST ${maxCost}`); // cannot happen: the quote is an upper bound
  return { tx, proof, fee, maxCostBound, maxCost };
}

export const randomNonceKey = (): bigint => BigInt(keccak256(crypto.getRandomValues(new Uint8Array(32))));
