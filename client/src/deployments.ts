// Our own deployed contracts on the devnet. `yarn check:devnet` asserts each still has code.
import type { Address } from "viem";

/** The live, staked TornadoExit (S5). Overridable for tests with EXIT_ADDRESS. */
export const EXIT = {
  address: (process.env.EXIT_ADDRESS ?? "0x5bcf973fbd8f50610061821cd7a83baf818828c3") as Address, // deploy 0xdae6…2b75, stake 0xda69…ac40
  verifier: "0x01163fc3ee187d4ff4234b47ff08d0238b5c6fd1" as Address, // Groth16TornadoVerifier (S4)
};

export const OUR_CONTRACTS: Record<string, Address> = {
  Groth16TornadoVerifier: EXIT.verifier,
  ...(EXIT.address !== "0x0000000000000000000000000000000000000000" ? { TornadoExit: EXIT.address } : {}),
};
