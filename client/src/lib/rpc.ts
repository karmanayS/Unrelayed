import { rpc as libRpc } from "@forshtat/hegota-support/rpc";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { CHAIN_ID, RPC_URL } from "../config.js";

export const devnet = defineChain({
  id: CHAIN_ID,
  name: "EIP-8141 alt-mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

/** A raw JSON-RPC call (throws RpcError with the node's message on an error reply). */
export const rpc = (method: string, params: unknown[] = [], url: string = RPC_URL): Promise<any> => libRpc(url, method, params);

export const publicClientFor = (url: string = RPC_URL) => createPublicClient({ chain: devnet, transport: http(url) });
export const client = publicClientFor();

export const getBalance = async (a: Address, url = RPC_URL): Promise<bigint> => BigInt(await rpc("eth_getBalance", [a, "latest"], url));
export const getCode = async (a: Address, url = RPC_URL): Promise<Hex> => rpc("eth_getCode", [a, "latest"], url);
export const blockNumber = async (url = RPC_URL): Promise<bigint> => BigInt(await rpc("eth_blockNumber", [], url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
