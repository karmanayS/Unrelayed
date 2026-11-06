import { parseAbi } from "viem";

export const tornadoAbi = parseAbi([
  "function levels() view returns (uint32)",
  "function denomination() view returns (uint256)",
  "function verifier() view returns (address)",
  "function hasher() view returns (address)",
  "function nextIndex() view returns (uint32)",
  "function getLastRoot() view returns (bytes32)",
  "function isKnownRoot(bytes32 root) view returns (bool)",
  "function isSpent(bytes32 nullifierHash) view returns (bool)",
  "function deposit(bytes32 commitment) payable",
  "function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund) payable",
  "event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)",
  "event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)",
]);

export const verifierAbi = parseAbi(["function verifyProof(bytes proof, uint256[6] input) view returns (bool)"]);

export const registryAbi = parseAbi([
  "function addStake(uint32 unstakeDelaySec) payable",
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
  "function unlockStake()",
  "function withdrawStake(address withdrawAddress)",
]);
