// Trains the tiny neural network that runs inside the reactive contract, then emits
//   model/weights.json        float and integer weights, metrics
//   src/WatchdogModel.sol     the same network as integer-only Solidity
//   model/vectors.json        test vectors (features -> expected integer logit) for forge tests
//
// Features (all in [0, 1], fixed-point scale S = 10_000 on-chain):
//   share        this withdrawal / vault balance before it
//   burst        withdrawals in the last 60 s / 10 (capped)
//   spike        this amount / running average amount / 20 (capped)
//   repeat       1 if the same address made the previous withdrawal
//   windowShare  sum of `share` over the last 60 s (capped at 1)
import fs from 'node:fs';

const S = 10_000;
const H = 8;
const F = 5;
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a, b) => a + (b - a) * rand();
const clamp = (x) => Math.max(0, Math.min(1, x));

function normal() {
  const big = rand() < 0.08; // an occasional large but isolated legitimate withdrawal
  const share = big ? between(0.1, 0.35) : between(0.0005, 0.06);
  const burst = rand() < 0.75 ? 0.1 * Math.floor(between(0, 2)) : 0.1 * Math.floor(between(1, 4));
  return [share, burst, clamp(between(0.1, big ? 0.6 : 0.2)), rand() < 0.3 ? 1 : 0, clamp(share + between(0, 0.08))];
}
function attack() {
  const kind = rand();
  if (kind < 0.3) {
    // one-shot drain
    const share = between(0.55, 1);
    return [share, 0.1 * Math.floor(between(0, 3)), clamp(between(0.5, 1)), rand() < 0.5 ? 1 : 0, clamp(share + between(0, 0.2))];
  }
  if (kind < 0.7) {
    // rapid repeated medium withdrawals from one address
    const share = between(0.08, 0.35);
    return [share, clamp(0.1 * Math.floor(between(3, 11))), clamp(between(0.3, 1)), 1, clamp(between(0.35, 1))];
  }
  // salami: many small fast withdrawals that add up
  const share = between(0.02, 0.1);
  return [share, clamp(0.1 * Math.floor(between(6, 11))), clamp(between(0.15, 0.6)), 1, clamp(between(0.3, 0.9))];
}

const data = [];
for (let i = 0; i < 6000; i++) data.push({ x: normal(), y: 0 });
for (let i = 0; i < 3000; i++) data.push({ x: attack(), y: 1 });
for (let i = data.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [data[i], data[j]] = [data[j], data[i]]; }
const test = data.splice(0, 1500);

// --- tiny MLP F -> H (ReLU) -> 1 (logit) ---
const W1 = Array.from({ length: H }, () => Array.from({ length: F }, () => between(-0.5, 0.5)));
const B1 = Array.from({ length: H }, () => 0);
const W2 = Array.from({ length: H }, () => between(-0.5, 0.5));
let B2 = 0;
const sig = (z) => 1 / (1 + Math.exp(-z));
function forward(x) {
  const h = W1.map((w, j) => Math.max(0, w.reduce((a, wi, i) => a + wi * x[i], B1[j])));
  return { h, z: h.reduce((a, hj, j) => a + W2[j] * hj, B2) };
}
const lr = 0.05;
for (let epoch = 0; epoch < 400; epoch++) {
  for (const { x, y } of data) {
    const { h, z } = forward(x);
    const g = sig(z) - y; // dLoss/dz for logistic loss
    for (let j = 0; j < H; j++) {
      const gh = h[j] > 0 ? g * W2[j] : 0;
      W2[j] -= lr * g * h[j];
      for (let i = 0; i < F; i++) W1[j][i] -= lr * gh * x[i];
      B1[j] -= lr * gh;
    }
    B2 -= lr * g;
  }
}

// --- quantise and mirror the Solidity arithmetic exactly ---
const q = (v) => Math.round(v * S);
const QW1 = W1.map((r) => r.map(q));
const QB1 = B1.map(q);
const QW2 = W2.map(q);
const QB2 = q(B2);
const tdiv = (a, b) => (a / b < 0 ? Math.ceil(a / b) : Math.floor(a / b)); // Solidity rounds toward zero
export function intLogit(xi) {
  // xi: integer features scaled by S
  const h = QW1.map((w, j) => {
    const v = tdiv(w.reduce((a, wi, i) => a + wi * xi[i], 0), S) + QB1[j];
    return v > 0 ? v : 0;
  });
  return tdiv(h.reduce((a, hj, j) => a + QW2[j] * hj, 0), S) + QB2;
}

const THRESHOLD = q(Math.log(0.9 / 0.1)); // pause only when p(attack) > 0.9
function evaluate(set) {
  let tp = 0, fp = 0, tn = 0, fn = 0, agree = 0;
  for (const { x, y } of set) {
    const zf = forward(x).z;
    const zi = intLogit(x.map((v) => Math.round(v * S)));
    if ((zf > Math.log(9)) === (zi > THRESHOLD)) agree++;
    const flag = zi > THRESHOLD;
    if (flag && y) tp++; else if (flag && !y) fp++; else if (!flag && !y) tn++; else fn++;
  }
  return { n: set.length, tp, fp, tn, fn, precision: tp / (tp + fp), recall: tp / (tp + fn), falsePositiveRate: fp / (fp + tn), floatIntAgreement: agree / set.length };
}
const metrics = evaluate(test);
console.log('held-out:', metrics);

// named scenarios used in the demo and the tests
const scenarios = {
  coffee: [0.004, 0.0, 0.08, 0, 0.004],
  rent: [0.05, 0.1, 0.15, 0, 0.06],
  whaleExit: [0.3, 0.0, 0.5, 0, 0.3],
  drainOneShot: [0.85, 0.1, 0.9, 1, 0.9],
  rapidRepeat: [0.2, 0.5, 0.6, 1, 0.6],
  salami: [0.05, 0.9, 0.3, 1, 0.45],
};
const vectors = Object.entries(scenarios).map(([name, x]) => {
  const xi = x.map((v) => Math.round(v * S));
  const logit = intLogit(xi);
  return { name, x: xi, logit, flagged: logit > THRESHOLD };
});
console.log(vectors.map((v) => `${v.name}: logit ${v.logit} ${v.flagged ? 'PAUSE' : 'ok'}`).join('\n'));

fs.writeFileSync('model/weights.json', JSON.stringify({ S, F, H, threshold: THRESHOLD, float: { W1, B1, W2, B2 }, int: { W1: QW1, B1: QB1, W2: QW2, B2: QB2 }, metrics }, null, 2));
fs.writeFileSync('model/vectors.json', JSON.stringify(vectors, null, 2));

// --- generate Solidity ---
const lines = [];
for (let j = 0; j < H; j++) {
  const terms = QW1[j].map((w, i) => `x[${i}] * (${w})`).join(' + ');
  lines.push(`        int256 h${j} = (${terms}) / S + (${QB1[j]});\n        if (h${j} < 0) h${j} = 0;`);
}
const out = QW2.map((w, j) => `h${j} * (${w})`).join(' + ');
const sol = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title WatchdogModel: a ${F}-${H}-1 neural network in integer arithmetic.
/// @notice Generated by model/train.mjs. Do not edit by hand; retrain and regenerate.
/// Held-out test set: precision ${metrics.precision.toFixed(3)}, recall ${metrics.recall.toFixed(3)},
/// false-positive rate ${metrics.falsePositiveRate.toFixed(4)}, float/integer agreement ${metrics.floatIntAgreement.toFixed(4)}.
library WatchdogModel {
    int256 internal constant S = ${S};
    /// Pause when the logit is above ln(9), that is p(attack) > 0.9.
    int256 internal constant THRESHOLD = ${THRESHOLD};

    /// @param x features scaled by S: share, burst, spike, repeat, windowShare
    /// @return logit attack logit scaled by S
    function logit(int256[${F}] memory x) internal pure returns (int256) {
${lines.join('\n')}
        return (${out}) / S + (${QB2});
    }
}
`;
fs.writeFileSync('src/WatchdogModel.sol', sol);
console.log('wrote src/WatchdogModel.sol');
