// Every address and endpoint the project uses (BUILD-PLAN §2.1). Addresses can change after a devnet reset:
// re-check deployments/devnet.md in forshtat/mempool-workshop-sidecar.
import type { Address } from "viem";

export const CHAIN_ID = 1337;

/** Sidecar (ERC-8421 alt mempool) RPC, and the gateway in front of it. */
export const SIDECAR_URL = "https://altmempool.forshtat.com/rpc";
export const GATEWAY_URL = "https://altmempoolgateway.forshtat.com/rpc";
/** ethrex (canonical mempool / execution client). */
export const ETHREX_URL = "https://altmempool.forshtat.com";
export const EXPLORER_URL = "https://explorer.altmempool.wtf";

/** The URL every frame tx is submitted to and every read goes through, overridable for T0.1 runs. */
export const RPC_URL = process.env.RPC_URL ?? SIDECAR_URL;

export const ADDR = {
  /** Tornado Cash 0.1 ETH pool (unmodified, predeployed). */
  TORNADO_POOL: "0xF8d72424D07721aB219cdbd2852657F3301673fC",
  /** Tornado Verifier (unmodified, predeployed). */
  TORNADO_VERIFIER: "0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01",
  /** Tornado MiMC hasher (unmodified, predeployed). */
  TORNADO_HASHER: "0x4500a5B572903a1DE1615d13A366cF2B324675E2",
  /** ERC-8421 NaiveStakingRegistry. */
  STAKING_REGISTRY: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
  /** EIP-8250 NONCE_MANAGER predeploy. */
  NONCE_MANAGER: "0x0000000000000000000000000000000000008250",
  /** EIP-8272 RECENT_ROOT_ADDRESS predeploy. */
  RECENT_ROOT: "0x0000000000000000000000000000000000008272",
  /** EIP-8141 ENTRY_POINT: msg.sender of VERIFY frames. */
  ENTRY_POINT: "0x00000000000000000000000000000000000000aa",
} as const satisfies Record<string, Address>;

/** Published genesis account (deploy/devnet/genesis.values.env). Used ONLY for the one S1 funding transfer. */
export const GENESIS_ADDRESS: Address = "0x5544596212F91984C986A919C8026DF0576816f9";

export const TORNADO = {
  levels: 20,
  denomination: 10n ** 17n,
  withdrawSelector: "0x21a0adb6",
} as const;

export const STAKE = {
  /** Strictly above the devnet minStake of 0.01 ETH. */
  amount: 12n * 10n ** 15n,
  unstakeDelaySec: 86400,
} as const;

/** Legacy txs: the devnet base fee is tiny; this clears it by a wide margin (workshop value). */
export const LEGACY_GAS_PRICE = 2_000_000n; // 0.002 gwei
/** maxFeePerGas of every frame tx (workshop value: 2 gwei). */
export const FRAME_MAX_FEE_PER_GAS = 2_000_000_000n;

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerReputation = () => `${EXPLORER_URL}/reputation`;

/** Our deployed contracts (live TornadoExit, Groth16TornadoVerifier): see deployments.ts. */
export { EXIT, OUR_CONTRACTS } from "./deployments.js";
