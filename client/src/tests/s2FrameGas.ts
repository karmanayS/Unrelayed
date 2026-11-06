// T2.6 (measurement part): the same withdraw as T2.6, but as the SENDER frame of a self-relay frame tx from the
// operator, so the receipt reports the frame's execution gas and state gas separately (legacy receipts do not).
// Same shape as the TornadoExit flow's frame 1: target = pool, value 0, fresh recipient, existing relayer.
import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, CHAIN_ID, explorerTx, FRAME_MAX_FEE_PER_GAS, TORNADO } from "../config.js";
import { operatorKey } from "../lib/env.js";
import { allFramesOk, newTx, secp256k1Placeholder, senderFrame, sendFrameTx, signTx, verifyFrame, waitFrameReceipt } from "../lib/frameTx.js";
import { deposit, NOTES_DIR, pool, proveWithdrawal, withdrawCalldata } from "../lib/tornado.js";
import { getBalance, rpc } from "../lib/rpc.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
const c = await deposit(key);
console.log(`deposit ${c.saved.depositTx} leaf ${c.event.leafIndex}, note ${c.file}`);
const recipient: Address = privateKeyToAccount(generatePrivateKey()).address;
const fee = 1_000_000_000_000_000n;
const p = await proveWithdrawal({ note: c.saved.note, nullifierHash: c.saved.nullifierHash, recipient, relayer: operator, fee });
const nonce = BigInt(await rpc("eth_getTransactionCount", [operator, "pending"]));
const tx = await signTx(newTx({
  chainId: CHAIN_ID, sender: operator, nonceSeq: nonce, maxFeePerGas: FRAME_MAX_FEE_PER_GAS, signatures: [secp256k1Placeholder()],
  frames: [verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }), senderFrame({ target: ADDR.TORNADO_POOL, execution: 2_000_000n, state: 2_000_000n, data: withdrawCalldata(p) })],
}), key);
const hash = await sendFrameTx(tx);
const r = await waitFrameReceipt(hash);
const f1 = r.frameReceipts![1] as any;
console.log(`frame withdraw ${hash} ${explorerTx(hash)} ok=${allFramesOk(r)}`);
console.log(`recipient ${await getBalance(recipient)} wei (expected ${TORNADO.denomination - fee}); isSpent ${await pool.isSpent(p.nullifierHash)}`);
console.log(`frame 1 (withdraw) gasUsed ${BigInt(f1.gasUsed)} stateGasUsed ${BigInt(f1.stateGasUsed)}; tx gasUsed ${BigInt(r.gasUsed!)}`);
const ok = allFramesOk(r) && (await getBalance(recipient)) === TORNADO.denomination - fee;
fs.writeFileSync(path.join(NOTES_DIR, "s2-frame-gas.json"), JSON.stringify({ hash, frame1GasUsed: BigInt(f1.gasUsed).toString(), frame1StateGasUsed: BigInt(f1.stateGasUsed).toString(), receipt: r }, null, 2) + "\n");
process.exit(ok ? 0 : 1);
