// S1 task 3 / T1.2 / T1.3: a self-relay frame tx from the operator EOA, built and signed by our own client code.
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, explorerTx, FRAME_MAX_FEE_PER_GAS } from "../config.js";
import { operatorKey } from "../lib/env.js";
import { allFramesOk, explorerTxDetail, newTx, secp256k1Placeholder, senderFrame, sendFrameTx, signTx, txHash, verifyFrame, waitFrameReceipt } from "../lib/frameTx.js";
import { getBalance, rpc } from "../lib/rpc.js";

const key = operatorKey();
const operator = privateKeyToAccount(key).address;
const to = (process.env.TO ?? "0x8943545177806ED17B9F23F0a21ee5948eCaa776") as `0x${string}`;
const nonce = BigInt(await rpc("eth_getTransactionCount", [operator, "pending"]));

const tx = await signTx(
  newTx({
    chainId: CHAIN_ID, sender: operator, nonceSeq: nonce, maxFeePerGas: FRAME_MAX_FEE_PER_GAS,
    signatures: [secp256k1Placeholder()],
    frames: [
      verifyFrame({ scope: "EXECUTION_AND_PAYMENT", execution: 30_000n }),
      senderFrame({ target: to, execution: 50_000n, state: 200_000n, value: 1_000_000_000n }),
    ],
  }),
  key,
);
const local = txHash(tx);
const balBefore = await getBalance(to);
const hash = await sendFrameTx(tx);
console.log(`submitted ${hash} (local hash ${local}, match: ${hash.toLowerCase() === local.toLowerCase()})`);
const r = await waitFrameReceipt(hash);
const ok = allFramesOk(r);
console.log(`T1.2 mined block ${BigInt(r.blockNumber)}, status ${r.status}, frames ${JSON.stringify((r.frameReceipts ?? []).map((f) => f.status))}: ${ok ? "PASS" : "FAIL"}`);
console.log(`recipient ${to}: ${balBefore} -> ${await getBalance(to)} wei`);
console.log(`explorer: ${explorerTx(hash)}`);
const detail = await explorerTxDetail(hash);
console.log("T1.3 admission report:");
console.log(JSON.stringify(detail?.admission ?? detail, null, 1));
console.log("lifecycle:", (detail?.events ?? []).map((e: any) => e.kind).join(" -> "));
process.exit(ok && detail?.admission ? 0 : 1);
