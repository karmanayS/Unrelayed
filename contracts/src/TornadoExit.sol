// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

interface ITornado {
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isSpent(bytes32 nullifierHash) external view returns (bool);
    function denomination() external view returns (uint256);
}

interface ITornadoVerifier {
    function verifyProof(bytes calldata proof, uint256[6] calldata input) external view returns (bool);
}

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
}

/// @title TornadoExit: a staked, shared EIP-8141 sender for relayer-free Tornado Cash withdrawals.
///
/// Every withdrawal is a frame transaction whose sender is this contract:
///
///   nonceKeys = [uint256(nullifierHash)], nonceSeq = 0, signatures = []
///   frame 0  VERIFY  target = this    scope = EXECUTION_AND_PAYMENT   data = verifyWithdrawal()
///   frame 1  SENDER  target = TORNADO value = 0    data = withdraw(proof, root, nullifierHash, recipient,
///                                                                  relayer = this, fee, refund = 0)
///
/// In frame 0 this contract checks the proof and Tornado's state and only then agrees to pay gas. Frame 1 calls the
/// unmodified pool, which pays `fee` back to this contract (the relayer). The person withdrawing signs nothing.
contract TornadoExit is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    // --------------------------------------------------------------------------------------- constants ----

    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;
    /// withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)
    bytes4 internal constant WITHDRAW_SELECTOR = 0x21a0adb6;
    /// selector ‖ 7 head words ‖ proof length word ‖ 256 proof bytes
    uint256 internal constant WITHDRAW_DATA_LENGTH = 4 + 7 * 32 + 32 + 256;
    uint256 internal constant PROOF_LENGTH = 256;
    /// Offset of the proof's length word, relative to the end of the selector (7 head words).
    uint256 internal constant PROOF_OFFSET = 7 * 32;
    /// FLAGS bit of an atomic batch frame (profile ethrex-eip8141-tracer).
    uint256 internal constant ATOMIC_BATCH_FLAG = 0x4;
    uint32 internal constant UNSTAKE_DELAY_SEC = 86400;

    // -------------------------------------------------------------------------------------- immutables ----

    ITornado public immutable TORNADO;
    ITornadoVerifier public immutable VERIFIER;
    IStakingRegistry public immutable REGISTRY;
    uint256 public immutable DENOMINATION;
    uint256 public immutable MIN_WITHDRAW_EXEC_GAS;
    uint256 public immutable MIN_WITHDRAW_STATE_GAS;
    address public immutable owner;

    error NotOwner();
    error NoFallback();

    constructor(
        address tornado,
        address verifier,
        address registry,
        uint256 minWithdrawExecGas,
        uint256 minWithdrawStateGas,
        address owner_
    ) payable {
        TORNADO = ITornado(tornado);
        VERIFIER = ITornadoVerifier(verifier);
        REGISTRY = IStakingRegistry(registry);
        DENOMINATION = ITornado(tornado).denomination();
        MIN_WITHDRAW_EXEC_GAS = minWithdrawExecGas;
        MIN_WITHDRAW_STATE_GAS = minWithdrawStateGas;
        owner = owner_;
    }

    // ------------------------------------------------------------------------------------------ VERIFY ----

    /// The VERIFY frame (frame 0) of every withdrawal. Approves execution and payment only if the transaction is
    /// exactly one Tornado withdrawal that reimburses this contract and cannot revert for a reason we can check.
    function verifyWithdrawal() external {
        // C0: only callable as a frame.
        require(msg.sender == ENTRY_POINT, "C0: not a frame");

        // C1: exact shape, no extra frames we would pay for.
        require(txparam(TxParam.FRAME_COUNT) == 2, "C1: frame count");
        require(txparam(TxParam.CURRENT_FRAME_INDEX) == 0, "C1: frame index");

        // C2: frame 1 is a plain SENDER call of the pool.
        require(frameparam(1, FrameParam.MODE) == uint256(FrameMode.SENDER), "C2: mode");
        require(frameparam(1, FrameParam.RESOLVED_TARGET) == uint256(uint160(address(TORNADO))), "C2: target");
        require(frameparam(1, FrameParam.VALUE) == 0, "C2: value");
        require(frameparam(1, FrameParam.FLAGS) & ATOMIC_BATCH_FLAG == 0, "C2: atomic batch");

        // C3: well-formed withdraw calldata with a 256-byte proof.
        require(frameparam(1, FrameParam.DATA_LENGTH) == WITHDRAW_DATA_LENGTH, "C3: data length");
        bytes memory data = framedatacopy(0, WITHDRAW_DATA_LENGTH, 1);
        bytes32 root;
        bytes32 nullifierHash;
        uint256 recipientWord;
        uint256 relayerWord;
        uint256 fee;
        uint256 refund;
        uint256 proofOffset;
        uint256 proofLength;
        bytes4 selector;
        assembly ("memory-safe") {
            let p := add(data, 0x20) // first byte of the calldata
            selector := mload(p)
            let head := add(p, 4)
            proofOffset := mload(head)
            root := mload(add(head, 0x20))
            nullifierHash := mload(add(head, 0x40))
            recipientWord := mload(add(head, 0x60))
            relayerWord := mload(add(head, 0x80))
            fee := mload(add(head, 0xa0))
            refund := mload(add(head, 0xc0))
            proofLength := mload(add(head, PROOF_OFFSET))
        }
        require(selector == WITHDRAW_SELECTOR, "C3: selector");
        require(proofOffset == PROOF_OFFSET && proofLength == PROOF_LENGTH, "C3: proof encoding");
        require(recipientWord >> 160 == 0 && relayerWord >> 160 == 0, "C3: address encoding");
        bytes memory proof = new bytes(PROOF_LENGTH);
        assembly ("memory-safe") {
            mcopy(add(proof, 0x20), add(add(data, 0x20), add(4, add(PROOF_OFFSET, 0x20))), PROOF_LENGTH)
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        address recipient = address(uint160(recipientWord)); // upper bits checked zero above
        // forge-lint: disable-next-line(unsafe-typecast)
        address relayer = address(uint160(relayerWord));

        // C4: we are reimbursed; Tornado's own requirements.
        require(relayer == address(this), "C4: relayer");
        require(refund == 0, "C4: refund");
        require(fee <= DENOMINATION, "C4: fee > denomination");

        // C5: the fee covers the worst-case gas cost.
        uint256 maxCost = txparam(TxParam.MAX_COST);
        require(fee >= maxCost, "C5: fee < max cost");

        // C6 (amended, PROGRESS.md ESCALATION 2): only `recipient != 0`. Reading a fresh recipient's code size is
        // rejected by the mempool's code-access rule; a recipient that reverts on receive costs us at most one
        // transaction per note, because C7 binds each note to a single (sender, key, seq 0) slot.
        require(recipient != address(0), "C6: recipient");

        // C7: mempool-level dedup per note.
        require(txparam(TxParam.NONCE_KEY_COUNT) == 1, "C7: nonce key count");
        require(txparam(TxParam.NONCE_KEY_0) == uint256(nullifierHash), "C7: nonce key");
        require(txparam(TxParam.NONCE) == 0, "C7: nonce");

        // C8: frame 1 has enough gas that the withdrawal cannot be made to run out of gas.
        require(frameparam(1, FrameParam.EXECUTION_GAS_LIMIT) >= MIN_WITHDRAW_EXEC_GAS, "C8: execution gas");
        require(frameparam(1, FrameParam.STATE_GAS_LIMIT) >= MIN_WITHDRAW_STATE_GAS, "C8: state gas");

        // C9: Tornado state (STORAGE-032 reads, staked).
        require(TORNADO.isKnownRoot(root), "C9: unknown root");
        require(!TORNADO.isSpent(nullifierHash), "C9: spent");

        // C10: the Groth16 proof, for exactly the public inputs the pool will check.
        require(
            VERIFIER.verifyProof(proof, [uint256(root), uint256(nullifierHash), recipientWord, relayerWord, fee, refund]),
            "C10: invalid proof"
        );

        // C11: we can pay (SELFBALANCE, staked only).
        require(address(this).balance >= maxCost, "C11: balance");

        // C12
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    // ------------------------------------------------------------------------------------- ETH and owner ----

    /// Tornado pays the relayer fee with a plain call. Never reaches approve.
    receive() external payable {}

    fallback() external payable {
        revert NoFallback();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Stakes this contract in the ERC-8421 registry (the registry keys on msg.sender).
    function stake() external payable onlyOwner {
        REGISTRY.addStake{value: msg.value}(UNSTAKE_DELAY_SEC);
    }

    function unlockStake() external onlyOwner {
        REGISTRY.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        REGISTRY.withdrawStake(to);
    }

    function withdrawFunds(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
