# Neural Watchdog: a neural network inside a reactive contract

**Reactive Omni Buildathon, "Reactive Meets AI" track**

Live dashboard: https://sainath998.github.io/neural-watchdog/ (`?run=video` shows the run from the video)

Treasuries, DAOs and apps keep a **hot operator key** for day-to-day payouts. When that key leaks, the drain starts at once, and humans and bots are too slow to stop it.

Neural Watchdog puts **the model inside the reactive contract**:

1. Every `Withdrawal` from the vault on Ethereum Sepolia reaches `NeuralWatchdog.react()` on Reactive Omni.
2. `react()` turns it into five features: share of the treasury, burst in the last 60 s, spike versus the running average, repeat recipient, and treasury share moved in the last 60 s.
3. It runs a **5 → 8 (ReLU) → 1 neural network in integer arithmetic, on-chain**, and publishes the score as a `Scored` event.
4. If p(attack) > 0.9, it requests a callback, and the vault **freezes itself**. Only the cold owner key can unfreeze it, and doing so rotates the operator.

There's no oracle, no model server and no off-chain bot. The AI is part of the running system: it decides what the reactive contract does next.

## What it did on testnet (the video run)

| Step | Amount | p(attack) on-chain | Result |
|---|---|---|---|
| Payroll | 0.004 ETH | 0.0000 | ok |
| Payroll | 0.004 ETH | 0.0000 | ok |
| Payroll | 0.004 ETH | 0.0000 | ok |
| Leaked key, drain 1 | 0.03 ETH | 0.0000 | ok (on its own it looks like a large payout) |
| Drain 2 | 0.03 ETH | 0.0063 | ok |
| Drain 3 | 0.03 ETH | **0.9999** | **freeze requested** |
| Drain 4 | 0.03 ETH | — | **reverted: vault frozen** |

The thief got 0.09 ETH, and **0.098 ETH was saved**. Without the watchdog, the same key empties the vault in four more transactions.

- Vault (Sepolia) [`0x4FeA868F…95aBa`](https://sepolia.etherscan.io/address/0x4FeA868F0eF13595a591572694EF322638D95aBa) · Watchdog (Lasna) [`0x12801A7E…4715`](https://lasna.reactscan.net/address/0x12801A7EEb708DFA3990eF43F5254E19Df2E4715)
- The drain that tripped it: [`0x827781…0a89`](https://sepolia.etherscan.io/tx/0x8277813e6c018d4e48ebc36ab1ce1c3e6efccbd5ad2c18390b85054a281b0a89) → on-chain score [`0xd7d6b5…a549`](https://lasna.reactscan.net/tx/0xd7d6b5442c2997c83ddae42642fe11537d854991395bbc8e3d8be21a0a1ca549) → freeze [`0x703d5e…ba41`](https://sepolia.etherscan.io/tx/0x703d5e3d724a38647faed7f5e3484aebce82f6019e9a4bac3401808eda7dba41)
- Every step, with its Sepolia and Lasna transactions, is in [`deployments/video-run-log.json`](deployments/video-run-log.json). An earlier run with the same result is in `deployments/run1-*`.

## The model
- **Training:** `model/train.mjs` is plain Node with no ML libraries. It generates labelled withdrawals: normal payroll and occasional large legitimate payouts, against one-shot drains, rapid repeated drains and "salami" drains. It then trains the 5-8-1 network by gradient descent.
- **Quantisation:** the weights are scaled by 10,000, and the trainer **generates `src/WatchdogModel.sol`** with the network unrolled in integer arithmetic, rounding toward zero like Solidity.
- **Bit-for-bit check:** `test_modelMatchesTheTrainingScriptBitForBit` feeds the trainer's test vectors to the Solidity model and checks the exact logits.
- **Held-out results (synthetic data):** precision 1.0, recall 1.0, 0 false positives in 989 normal withdrawals, and float/integer agreement of 100%. These numbers are on synthetic data. Real deployments would retrain on the vault's own history; the pipeline stays the same.
- **Threshold:** freeze at p > 0.9 (logit > ln 9), which is checked on the logit, so no on-chain exp() is needed.

## Contracts
- [`src/NeuralWatchdog.sol`](src/NeuralWatchdog.sol) on Lasna:
  - subscribes to the vault's `Withdrawal` and `Unfrozen` events
  - keeps a 10-slot ring buffer of recent withdrawals and an EMA of amounts
  - computes features, runs the model, and emits `Scored`
  - requests `freeze()` once per incident and re-arms on `Unfrozen`
- [`src/GuardedVault.sol`](src/GuardedVault.sol) on Sepolia:
  - roles: a cold owner, a hot operator and the watchdog
  - `freeze()` is callable only through the Reactive callback proxy, on behalf of this watchdog (`onlyServiceProvider` + `onlyCallbackSender`)
  - `unfreeze(newOperator)` is owner-only and rotates the hot key
  - the treasury is tracked separately from the callback gas reserve
- [`src/WatchdogModel.sol`](src/WatchdogModel.sol): generated, do not edit.

## Run it
```bash
node model/train.mjs        # train, quantise, regenerate src/WatchdogModel.sol + test vectors
forge test                  # 5 tests: model bit-exactness, payroll never freezes, one-shot drain,
                            # rapid drain frozen within a few withdrawals, freeze/unfreeze authorisation
node scripts/deploy.mjs     # deploy watchdog (Lasna) + vault (Sepolia), link, fund
node scripts/demo.mjs       # payroll, then a leaked-key drain; logs scores and the freeze
```
The deployer key is read from `~/.reactive-testnet-key.json` (testnet only).

## Limits and next steps
- A false positive costs a pause, not funds: the owner reviews and unfreezes. That is the trade-off of acting automatically.
- Drains of up to 2 transactions can land before the freeze, because the model needs a pattern. A per-transaction cap on the vault would bound that.
- Next:
  - train on real treasury histories
  - per-vault thresholds set by the owner
  - more features, such as a new-recipient flag and time of day
  - the same watchdog for ERC-20 `Transfer` events

## License
MIT
