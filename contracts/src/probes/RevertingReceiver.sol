// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A contract whose receive() reverts: used as a contract address in T3.9 and as the contract recipient of T5.2(l).
contract RevertingReceiver {
    receive() external payable {
        revert("no ETH accepted");
    }
}
