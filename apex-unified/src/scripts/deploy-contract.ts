import * as dotenv from 'dotenv';
import { ethers }  from 'ethers';
import * as fs     from 'fs';
import * as path   from 'path';

dotenv.config();

// ── ApexFlashLoan bytecode (compile with: npx solc --bin --abi src/contracts/ApexFlashLoan.sol) ──
// Pre-compiled for Base mainnet (solc 0.8.19, optimizer 200 runs)
// To recompile: cd apex-unified && npx solc@0.8.19 --bin --abi --optimize --optimize-runs 200 src/contracts/ApexFlashLoan.sol

const ABI = [
  'constructor()',
  'function setSplit(address _taxWallet, uint256 _taxBps) external',
  'function setMinProfit(uint256 _min) external',
  'function setPaused(bool _paused) external',
  'function owner() view returns (address)',
  'function taxWallet() view returns (address)',
  'function taxBps() view returns (uint256)',
  'function paused() view returns (bool)',
  'function executeArbitrage(address flashToken, uint256 flashAmount, address uniV3Router, bytes calldata path, uint256 minAmountOut) external',
  'function setRouter(address router, bool approved) external',
  'event ArbitrageExecuted(address indexed token, uint256 amountIn, uint256 profit, uint256 taxAmount)',
];

// Approved routers on Base mainnet
const UNI_V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const CAKE_V3_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';

async function main(): Promise<void> {
  // ── Safety checks ──────────────────────────────────────────────────────────
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const rpcUrl = process.env.ALCHEMY_WSS_URL?.replace('wss://', 'https://') ??
                 process.env.ALCHEMY_HTTP_URL;
  if (!rpcUrl) {
    console.error('ALCHEMY_WSS_URL or ALCHEMY_HTTP_URL not set in .env');
    process.exit(1);
  }

  const taxWallet = process.env.TAX_WALLET ?? '';
  const taxBps    = parseInt(process.env.TAX_BPS ?? '0', 10);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  const network = await provider.getNetwork();
  if (network.chainId !== 8453n) {
    console.error(`Wrong network: chainId=${network.chainId} — deploy only to Base (8453)`);
    process.exit(1);
  }

  const balance = await provider.getBalance(wallet.address);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   ApexFlashLoan — Base Mainnet Deployment   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Deployer:   ${wallet.address}`);
  console.log(`  Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log(`  Chain:      Base (${network.chainId})`);
  if (taxWallet) {
    console.log(`  Tax wallet: ${taxWallet} (${taxBps} bps)`);
  } else {
    console.log(`  Tax wallet: not configured (set TAX_WALLET + TAX_BPS in .env to enable)`);
  }
  console.log('');

  if (balance < ethers.parseEther('0.005')) {
    console.error('Balance below 0.005 ETH — not enough for gas. Add ETH to your wallet.');
    process.exit(1);
  }

  // ── Load bytecode ──────────────────────────────────────────────────────────
  const bytecodePath = path.resolve(__dirname, '../../compiled/ApexFlashLoan.bin');
  if (!fs.existsSync(bytecodePath)) {
    console.error(`Compiled bytecode not found at ${bytecodePath}`);
    console.error('Run: npx solc@0.8.19 --bin --abi --optimize --optimize-runs 200 --output-dir compiled src/contracts/ApexFlashLoan.sol');
    process.exit(1);
  }
  const bytecode = '0x' + fs.readFileSync(bytecodePath, 'utf8').trim();

  // ── Deploy ─────────────────────────────────────────────────────────────────
  console.log('Deploying ApexFlashLoan...');
  const factory  = new ethers.ContractFactory(ABI, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`\n  Contract deployed: ${address}`);
  console.log(`  Tx hash: ${contract.deploymentTransaction()?.hash}`);

  // ── Whitelist routers ─────────────────────────────────────────────────────
  const deployed = new ethers.Contract(address, ABI, wallet);
  console.log('\nWhitelisting Uniswap V3 Router...');
  await (await deployed.setRouter(UNI_V3_ROUTER,  true)).wait();
  console.log(`  Uni V3 Router whitelisted:        ${UNI_V3_ROUTER}`);
  console.log('Whitelisting PancakeSwap V3 Router...');
  await (await deployed.setRouter(CAKE_V3_ROUTER, true)).wait();
  console.log(`  PancakeSwap V3 Router whitelisted: ${CAKE_V3_ROUTER}`);

  // ── Configure split (optional) ─────────────────────────────────────────────
  if (taxWallet && taxBps > 0) {
    console.log(`\nConfiguring profit split: ${taxBps} bps → ${taxWallet}`);
    const tx = await deployed.setSplit(taxWallet, taxBps);
    await tx.wait();
    console.log('  Split configured.');
  }

  // ── Write address to .env ──────────────────────────────────────────────────
  const envPath = path.resolve(__dirname, '../../../.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('APEX_FLASH_LOAN_BASE=')) {
      envContent = envContent.replace(/APEX_FLASH_LOAN_BASE=.*/,
        `APEX_FLASH_LOAN_BASE=${address}`);
    } else {
      envContent += `\nAPEX_FLASH_LOAN_BASE=${address}\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log(`\n  .env updated: APEX_FLASH_LOAN_BASE=${address}`);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║               DEPLOYMENT COMPLETE           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  Add to .env or GitHub secrets:`);
  console.log(`  APEX_FLASH_LOAN_BASE=${address}`);
  console.log('\n  Next: run npm run dry-run to verify, then go live.\n');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
