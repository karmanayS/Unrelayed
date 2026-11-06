// Plain legacy transactions (deployments, deposits, owner calls, the one funding transfer), sent through RPC_URL.
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { CHAIN_ID, LEGACY_GAS_PRICE } from "../config.js";
import { rpc, sleep } from "./rpc.js";

export interface LegacyTx {
  to: Address | null;
  value?: bigint;
  data?: Hex;
  gas: bigint;
}

export async function sendLegacy(key: Hex, tx: LegacyTx): Promise<Hex> {
  const account = privateKeyToAccount(key);
  const nonce = Number(await rpc("eth_getTransactionCount", [account.address, "pending"]));
  const raw = await account.signTransaction({
    chainId: CHAIN_ID, nonce, to: tx.to, value: tx.value ?? 0n, data: tx.data ?? "0x",
    gas: tx.gas, gasPrice: LEGACY_GAS_PRICE, type: "legacy",
  });
  return rpc("eth_sendRawTransaction", [raw]);
}

export async function waitReceipt(hash: Hex, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(2000);
  }
  throw new Error(`tx ${hash} not mined within ${timeoutMs / 1000}s`);
}

/** Sends, waits, and throws if the receipt status is not success. */
export async function sendLegacyAndWait(key: Hex, tx: LegacyTx): Promise<{ hash: Hex; receipt: any }> {
  const hash = await sendLegacy(key, tx);
  const receipt = await waitReceipt(hash);
  if (receipt.status !== "0x1") throw new Error(`legacy tx ${hash} reverted (gasUsed ${BigInt(receipt.gasUsed)})`);
  return { hash, receipt };
}
