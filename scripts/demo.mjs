// Real testnet run: normal payroll, then a leaked-key drain. Logs the network's score for
// every withdrawal (read back from the watchdog's Scored events on Lasna) and the freeze.
import fs from 'node:fs';
import { ethers } from 'ethers';

const sepolia = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com');
const lasna = new ethers.JsonRpcProvider(process.env.LASNA_RPC || 'https://lasna-rpc.rnk.dev/');
const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT || 'deployments/sepolia-lasna.json', 'utf8'));
const op = new ethers.Wallet(JSON.parse(fs.readFileSync('deployments/operator.keys.json', 'utf8')).privateKey, sepolia);
const V = JSON.parse(fs.readFileSync('out/GuardedVault.sol/GuardedVault.json', 'utf8'));
const W = JSON.parse(fs.readFileSync('out/NeuralWatchdog.sol/NeuralWatchdog.json', 'utf8'));
const vault = new ethers.Contract(dep.vault, V.abi, op);
const dog = new ethers.Contract(dep.watchdog, W.abi, lasna);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = { steps: [] };
const LOG = process.env.DEMO_LOG || 'deployments/demo-log.json';
const save = () => fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
const lasnaStart = await lasna.getBlockNumber();
const S = 10000;

async function scoreFor(txHash, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const logs = await dog.queryFilter(dog.filters.Scored(BigInt(txHash)), lasnaStart);
    if (logs.length) {
      const a = logs[0].args;
      return { lasnaTx: logs[0].transactionHash, features: a[3].map((v) => Number(v) / S), logit: Number(a[4]) / S, p: 1 / (1 + Math.exp(-Number(a[4]) / S)), freeze: a[5] };
    }
    await sleep(1500);
  }
  return null;
}

async function pay(label, to, eth) {
  try {
    const tx = await vault.withdraw(to, ethers.parseEther(eth));
    const rc = await tx.wait();
    const s = await scoreFor(tx.hash);
    const line = `${label.padEnd(10)} ${eth} ETH → ${to.slice(0, 8)}  p(attack)=${s ? s.p.toFixed(4) : '?'}  ${s?.freeze ? 'FREEZE' : 'ok'}  sepolia ${tx.hash}`;
    console.log(line);
    log.steps.push({ label, to, eth, sepoliaTx: tx.hash, block: rc.blockNumber, score: s });
    save();
    return s;
  } catch (e) {
    const reason = e.shortMessage || e.message;
    console.log(`${label.padEnd(10)} ${eth} ETH → REVERTED (${/Frozen|0x[0-9a-f]{8}/.test(reason) ? 'vault frozen' : reason.slice(0, 80)})`);
    log.steps.push({ label, to, eth, reverted: reason });
    save();
    return { reverted: true };
  }
}

const staff = ['0x000000000000000000000000000000000000a11c', '0x000000000000000000000000000000000000b0b0', '0x000000000000000000000000000000000000c4a5'].map(ethers.getAddress);
const thief = ethers.getAddress('0x000000000000000000000000000000000000bad1');
console.log('treasury', ethers.formatEther(await vault.treasury()), 'ETH');
console.log('\n— normal day: payroll —');
for (let i = 0; i < 3; i++) { await pay('payroll', staff[i], '0.004'); await sleep(20000); }
console.log('\n— the operator key leaks —');
const before = await vault.treasury();
for (let i = 0; i < 6; i++) {
  const r = await pay('drain', thief, '0.03');
  if (r?.reverted) break;
  if (await vault.frozen()) { console.log('vault frozen by the watchdog'); }
}
const frozenLogs = await new ethers.Contract(dep.vault, V.abi, sepolia).queryFilter('FrozenByWatchdog', -200);
const after = await vault.treasury();
log.freezeTx = frozenLogs.at(-1)?.transactionHash;
log.saved = ethers.formatEther(after);
log.stolen = ethers.formatEther(before - after);
save();
console.log(`\nfrozen: ${await vault.frozen()}  freeze tx ${log.freezeTx}\nstolen ${log.stolen} ETH, saved ${log.saved} ETH`);
