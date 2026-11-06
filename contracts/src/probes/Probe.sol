// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

interface ITornadoView {
    function isKnownRoot(bytes32 root) external view returns (bool);
    function isSpent(bytes32 nullifierHash) external view returns (bool);
}

interface IVerifier {
    function verifyProof(bytes calldata proof, uint256[6] calldata input) external view returns (bool);
}

/// S3 validation-rule probe (BUILD-PLAN §S3). A contract tx.sender whose VERIFY frame runs one of the `v*`
/// functions below. Each one reads a value inside VERIFY and `require`s it to equal the expected value passed in the
/// frame data, then approves execution and payment: admission means "equal", rejection means "not equal" (or that a
/// mempool rule rejected the read itself).
contract Probe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    address public immutable registry;

    constructor(address registry_) payable {
        owner = msg.sender;
        registry = registry_;
    }

    receive() external payable {}

    /// Stakes this contract (the registry keys on msg.sender). Owner-only; called in a legacy tx.
    function stake(uint32 unstakeDelaySec) external payable {
        require(msg.sender == owner, "not owner");
        IStakingRegistry(registry).addStake{value: msg.value}(unstakeDelaySec);
    }

    // ------------------------------------------------------------------ VERIFY entry points ----------

    /// T3.1–T3.4: no checks, just approve.
    function vPlain() external {
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.10: msg.sender inside VERIFY.
    function vCaller(address expected) external {
        require(msg.sender == expected, "caller mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.5: STORAGE-032 reads of the Tornado pool.
    function vTornadoReads(address pool, bytes32 root, bool expKnown, bytes32 nullifierHash, bool expSpent) external {
        require(ITornadoView(pool).isKnownRoot(root) == expKnown, "isKnownRoot mismatch");
        require(ITornadoView(pool).isSpent(nullifierHash) == expSpent, "isSpent mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.6 / T4.4 / T4.5: a Groth16 verifier called inside VERIFY.
    function vVerifier(address verifier, bytes calldata proof, uint256[6] calldata input, bool expected) external {
        require(IVerifier(verifier).verifyProof(proof, input) == expected, "verifyProof mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.7: TXPARAM values. `ids[i]` is a TxParam id, `expected[i]` its expected value.
    function vTxParams(uint256[] calldata ids, uint256[] calldata expected) external {
        require(ids.length == expected.length, "length");
        for (uint256 i = 0; i < ids.length; i++) {
            require(txparam(TxParam(ids[i])) == expected[i], string(abi.encodePacked("txparam mismatch #", bytes1(uint8(48 + i)))));
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.7: FRAMEPARAM values of frame `frameIndex`.
    function vFrameParams(uint256 frameIndex, uint256[] calldata ids, uint256[] calldata expected) external {
        require(ids.length == expected.length, "length");
        for (uint256 i = 0; i < ids.length; i++) {
            require(frameparam(frameIndex, FrameParam(ids[i])) == expected[i], string(abi.encodePacked("frameparam mismatch #", bytes1(uint8(48 + i)))));
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.7: FRAMEDATACOPY(0, len, frameIndex) hashes to `expectedHash`.
    function vFrameData(uint256 frameIndex, uint256 len, bytes32 expectedHash) external {
        require(keccak256(framedatacopy(0, len, frameIndex)) == expectedHash, "framedata mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.8: SELFBALANCE.
    function vSelfBalance(uint256 expected) external {
        require(address(this).balance == expected, "selfbalance mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.7 diagnosis: admitted iff lo <= txparam(id) <= hi (used to bracket a value that disagrees).
    function vTxParamBetween(uint256 id, uint256 lo, uint256 hi) external {
        uint256 v = txparam(TxParam(id));
        require(v >= lo && v <= hi, "txparam out of range");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// T3.9: EXTCODESIZE of an address.
    function vCodeSize(address a, uint256 expected) external {
        require(a.code.length == expected, "codesize mismatch");
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
