// Deploys NeuralWatchdog (Lasna) and GuardedVault (Sepolia), links them, funds the treasury.
import fs from 'node:fs';
import os from 'node:os';
import { ethers } from 'ethers';

const sepolia = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com');
const lasna = new ethers.JsonRpcProvider(process.env.LASNA_RPC || 'https://lasna-rpc.rnk.dev/');
const key = JSON.parse(fs.readFileSync(`${os.homedir()}/.reactive-testnet-key.json`, 'utf8')).privateKey;
const ownerS = new ethers.Wallet(key, sepolia);
const ownerL = new ethers.Wallet(key, lasna);
const art = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8'));
const PROXY = '0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4';

const kf = 'deployments/operator.keys.json';
const op = fs.existsSync(kf) ? JSON.parse(fs.readFileSync(kf, 'utf8')) : (() => { const w = ethers.Wallet.createRandom(); const o = { address: w.address, privateKey: w.privateKey }; fs.writeFileSync(kf, JSON.stringify(o, null, 2), { mode: 0o600 }); return o; })();
const lb = await lasna.getBlock('latest');
const fees = { maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'), maxFeePerGas: (lb.baseFeePerGas ?? 0n) * 2n + ethers.parseUnits('2', 'gwei') };

const W = art('NeuralWatchdog');
const dog = await new ethers.ContractFactory(W.abi, W.bytecode.object, ownerL).deploy(11155111n, { value: ethers.parseEther(process.env.WATCHDOG_FUND || '1.5'), ...fees });
await dog.waitForDeployment();
const V = art('GuardedVault');
const vault = await new ethers.ContractFactory(V.abi, V.bytecode.object, ownerS).deploy(PROXY, await dog.getAddress(), op.address, { value: ethers.parseEther('0.03') });
await vault.waitForDeployment();
const linkTx = await dog.link(await vault.getAddress(), fees);
await linkTx.wait();
const fundTx = await vault.fund({ value: ethers.parseEther(process.env.TREASURY || '0.2') });
await fundTx.wait();
if ((await sepolia.getBalance(op.address)) < ethers.parseEther('0.005')) await (await ownerS.sendTransaction({ to: op.address, value: ethers.parseEther('0.01') })).wait();
const out = {
  watchdog: await dog.getAddress(), vault: await vault.getAddress(), operator: op.address,
  txs: { deployWatchdog: dog.deploymentTransaction().hash, deployVault: vault.deploymentTransaction().hash, link: linkTx.hash, fund: fundTx.hash },
};
fs.writeFileSync(process.env.DEPLOYMENT || 'deployments/sepolia-lasna.json', JSON.stringify(out, null, 2));
console.log(out);
