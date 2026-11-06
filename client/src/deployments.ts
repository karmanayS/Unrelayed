// Our own deployed contracts on the devnet. `yarn check:devnet` asserts each still has code.
import type { Address } from "viem";

/** The live, staked TornadoExit (S5). Overridable for tests with EXIT_ADDRESS. */
export const EXIT = {
  address: (process.env.EXIT_ADDRESS ?? "0x1ce44ca7680af352ac3817d0b5f758a4c3042463") as Address, // deploy 0xb8da…b665, stake 0x1293…570f
  verifier: "0x01163fc3ee187d4ff4234b47ff08d0238b5c6fd1" as Address, // Groth16TornadoVerifier (S4)
};

export const OUR_CONTRACTS: Record<string, Address> = {
  Groth16TornadoVerifier: EXIT.verifier,
  ...(EXIT.address !== "0x0000000000000000000000000000000000000000" ? { TornadoExit: EXIT.address } : {}),
};
