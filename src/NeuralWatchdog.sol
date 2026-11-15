// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { WatchdogModel } from "./WatchdogModel.sol";

/// @title NeuralWatchdog: a neural network inside a reactive contract.
/// @notice Every Withdrawal from a GuardedVault reaches react(). The contract turns it into
/// five features, runs a small neural network on them (WatchdogModel, integer arithmetic,
/// on-chain), and publishes the score. When the network is more than 90% sure it is
/// looking at a drain, it asks Reactive Network to call freeze() on the vault.
/// No oracle, no off-chain model server: the AI is part of the running system.
contract NeuralWatchdog is AbstractReactive {
    error NotOwner();
    error AlreadyLinked();

    uint256 internal constant WITHDRAWAL_TOPIC = uint256(keccak256("Withdrawal(address,uint256,uint256)"));
    uint256 internal constant UNFROZEN_TOPIC = uint256(keccak256("Unfrozen(address)"));
    int256 internal constant S = 10_000;
    uint256 internal constant WINDOW = 60; // seconds
    uint64 internal constant CALLBACK_GAS = 300_000;

    address public immutable owner;
    uint256 public immutable originChainId;
    address public vault;

    // rolling state used to build features
    uint256[10] internal recentTimes;
    int256[10] internal recentShares;
    uint256 internal head;
    int256 public avgAmount; // running average withdrawal amount (wei), EMA with alpha 1/8
    address public lastTo;
    bool public freezeRequested;
    uint256 public scored;

    event Linked(uint256 chainId_, address vault_);
    event Scored(uint256 indexed txHash_, address indexed to_, uint256 amount_, int256[5] features_, int256 logit_, bool freeze_);
    event FreezeRequested(uint256 indexed txHash_, int256 logit_);

    constructor(uint256 originChainId_) payable {
        owner = msg.sender;
        originChainId = originChainId_;
    }

    function link(address vault_) external {
        if (msg.sender != owner) revert NotOwner();
        if (vault != address(0)) revert AlreadyLinked();
        vault = vault_;
        SYSTEM.subscribe(originChainId, vault_, WITHDRAWAL_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, vault_, UNFROZEN_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Linked(originChainId, vault_);
    }

    /// @inheritdoc IReactive
    function react(LogRecord memory log_) external onlySystem {
        if (log_.chainId != originChainId || log_.contractAddress != vault) return;
        if (log_.topic0 == UNFROZEN_TOPIC) {
            freezeRequested = false;
            return;
        }
        if (log_.topic0 != WITHDRAWAL_TOPIC) return;
        address to = address(uint160(log_.topic1));
        (uint256 amount, uint256 balanceAfter) = abi.decode(log_.data, (uint256, uint256));
        (int256[5] memory x) = features(to, amount, balanceAfter, block.timestamp);
        int256 z = WatchdogModel.logit(x);
        bool trip = z > WatchdogModel.THRESHOLD;
        scored += 1;
        emit Scored(log_.txHash, to, amount, x, z, trip);
        _remember(to, amount, x[0], block.timestamp);
        if (trip && !freezeRequested) {
            freezeRequested = true;
            emit FreezeRequested(log_.txHash, z);
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0({
                    chainId: originChainId,
                    recipient: vault,
                    gasLimit: CALLBACK_GAS,
                    payload: abi.encodeWithSignature("freeze(address,int256,uint256)", address(0), z, log_.txHash)
                })
            );
        }
    }

    /// @notice The five features, scaled by S: share, burst, spike, repeat, windowShare.
    function features(address to_, uint256 amount_, uint256 balanceAfter_, uint256 now_) public view returns (int256[5] memory x) {
        uint256 before = balanceAfter_ + amount_;
        int256 share = before == 0 ? S : int256((amount_ * uint256(S)) / before);
        uint256 burst;
        int256 window = share;
        for (uint256 i = 0; i < 10; i++) {
            if (recentTimes[i] != 0 && now_ - recentTimes[i] <= WINDOW) {
                burst += 1;
                window += recentShares[i];
            }
        }
        int256 spike;
        if (avgAmount <= 0) spike = S / 20; // first withdrawal: neutral
        else {
            int256 ratio = (int256(amount_) * S) / avgAmount; // amount / average, scaled
            spike = ratio / 20;
        }
        x[0] = _cap(share);
        x[1] = _cap(int256(burst) * S / 10);
        x[2] = _cap(spike);
        x[3] = (to_ == lastTo && lastTo != address(0)) ? S : int256(0);
        x[4] = _cap(window);
    }

    function _remember(address to_, uint256 amount_, int256 share_, uint256 now_) internal {
        recentTimes[head] = now_;
        recentShares[head] = share_;
        head = (head + 1) % 10;
        lastTo = to_;
        int256 a = int256(amount_);
        avgAmount = avgAmount == 0 ? a : avgAmount + (a - avgAmount) / 8;
    }

    function _cap(int256 v) internal pure returns (int256) {
        return v < 0 ? int256(0) : (v > S ? S : v);
    }

    function coverDebt() external {
        _coverDebt();
    }
}
