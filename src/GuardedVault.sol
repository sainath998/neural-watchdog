// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

/// @title GuardedVault: a treasury with a hot operator key, watched by a neural network.
/// @notice The cold owner key funds the vault and appoints an operator (a hot key used for
/// day-to-day payouts). If the operator key leaks, an attacker can start draining it.
/// NeuralWatchdog on Reactive Network scores every Withdrawal with an on-chain neural
/// network and, when it looks like a drain, calls freeze() through the Reactive callback
/// proxy, often before the next withdrawal lands. Only the cold owner can unfreeze.
contract GuardedVault is AbstractCallback {
    error NotOwner();
    error NotOperator();
    error Frozen();
    error NoFunds(uint256 requested_, uint256 available_);

    event Funded(address indexed from_, uint256 amount_, uint256 balance_);
    event Withdrawal(address indexed to_, uint256 amount_, uint256 balanceAfter_);
    event FrozenByWatchdog(int256 logit_, uint256 triggerTx_, uint256 balanceSaved_);
    event Unfrozen(address indexed newOperator_);

    address public immutable owner;
    address public operator;
    bool public frozen;
    /// Treasury funds, tracked apart from the small gas reserve that pays for callbacks.
    uint256 public treasury;

    constructor(IPayable callbackProxy_, address watchdog_, address operator_) payable AbstractCallback(callbackProxy_, watchdog_) {
        owner = msg.sender;
        operator = operator_;
    }

    /// @notice Add funds to the treasury (anyone can fund it).
    function fund() external payable {
        treasury += msg.value;
        emit Funded(msg.sender, msg.value, treasury);
    }

    /// @notice Day-to-day payouts by the operator key.
    function withdraw(address payable to_, uint256 amount_) external {
        if (msg.sender != operator) revert NotOperator();
        if (frozen) revert Frozen();
        if (amount_ > treasury) revert NoFunds(amount_, treasury);
        treasury -= amount_;
        emit Withdrawal(to_, amount_, treasury);
        (bool ok,) = to_.call{ value: amount_ }("");
        require(ok, "transfer failed");
    }

    /// @notice Called only by Reactive Network on behalf of NeuralWatchdog.
    function freeze(address watchdog_, int256 logit_, uint256 triggerTx_)
        external
        onlyServiceProvider
        onlyCallbackSender(watchdog_)
    {
        if (frozen) return;
        frozen = true;
        emit FrozenByWatchdog(logit_, triggerTx_, treasury);
    }

    /// @notice The cold owner reviews, rotates the operator key and resumes.
    function unfreeze(address newOperator_) external {
        if (msg.sender != owner) revert NotOwner();
        frozen = false;
        operator = newOperator_;
        emit Unfrozen(newOperator_);
    }

    /// @notice Settle callback debt from the gas reserve.
    function coverDebt() external {
        _coverDebt();
    }

}
