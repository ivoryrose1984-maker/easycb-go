# 🧪 Complete Testing Framework - Apex Predator Bot

## Pre-Deploy Checklist

### 1. Environment Setup
```bash
# ✅ Check all env vars are set
cd /workspaces/apex-predator-mev
cat .env.testnet

# Required vars:
# - ALCHEMY_WSS_URL (NEW rotated key)
# - PRIVATE_KEY (NEW wallet)
# - SUPABASE_URL (optional but recommended)
# - SUPABASE_ANON_KEY (optional but recommended)
# - TELEGRAM_BOT_TOKEN (optional)
# - TELEGRAM_CHAT_ID (optional)
# - DRY_RUN=true
```

### 2. Dependencies
```bash
# ✅ Install all packages
npm install --legacy-peer-deps

# ✅ Verify key packages
npm list ethers @flashbots/ethers-provider-bundle @supabase/supabase-js
```

### 3. Compilation
```bash
# ✅ Build TypeScript
npm run build

# ✅ Check for errors
# Should see "Compiled successfully" with no errors
```

### 4. Contract Deployment Check
```bash
# ✅ Verify contract exists on Sepolia
# Check: https://sepolia.etherscan.io/address/0x7ef837763674380CFbfa0B9d01F5d2F8e0288944

# Should show:
# - Contract deployed
# - Has code (not empty)
# - Can view contract ABI
```

### 5. Wallet Funding
```bash
# ✅ Check wallet balance
node -e "
const ethers = require('ethers');
const provider = new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY');
const address = 'YOUR_WALLET_ADDRESS';
provider.getBalance(address).then(b => console.log('Balance:', ethers.formatEther(b), 'ETH'));
"

# Need: >0.1 ETH for testnet testing
# Get from: https://sepoliafaucet.com/
```

---

## Phase 1: Component Testing (Isolated)

### Test 1: WSS Connection Stability
```bash
# Run this test:
node -e "
const { createWsProvider } = require('./dist/infrastructure/wsProvider');
(async () => {
  console.log('[TEST] Connecting to WSS...');
  const provider = await createWsProvider(process.env.ALCHEMY_WSS_URL);
  console.log('[TEST] ✅ Connected');
  
  // Wait 5 minutes
  console.log('[TEST] Waiting 5 minutes for keepalive test...');
  await new Promise(r => setTimeout(r, 300000));
  
  // Try to use it
  const block = await provider.getBlockNumber();
  console.log('[TEST] ✅ Still alive! Block:', block);
  
  await provider.destroy();
  console.log('[TEST] ✅ Test passed');
})();
"

# Expected: No disconnects, stays alive full 5 minutes
# ❌ If crashes before 5 min -> WSS keepalive broken
```

### Test 2: Gas Forecaster
```bash
node -e "
const ethers = require('ethers');
const { getGasForecast } = require('./dist/infrastructure/gasForecaster');

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_WSS_URL.replace('wss:', 'https:'));
  
  const forecast = await getGasForecast(provider);
  console.log('Gas Forecast:', {
    baseFee: ethers.formatUnits(forecast.predictedBaseFee, 'gwei'),
    volatility: (forecast.volatility * 100).toFixed(1) + '%',
    priorityPct: forecast.dynamicPriorityPct + '%'
  });
  
  console.log('✅ Gas forecaster working');
})();
"

# Expected: Returns forecast with reasonable values
# ❌ If error -> Check provider connection
```

### Test 3: Bid Math Accuracy
```bash
node -e "
const { calculateNetProfit } = require('./dist/core/bidMath');

// Test case: $1000 USDC arb
const amountIn = 1000000000n; // 1000 USDC
const buyQuote = 400000000000000000n; // 0.4 WETH
const sellQuote = 1015000000n; // 1015 USDC (1.5% gross profit)
const ethPrice = 2500000000n; // $2500/ETH

const gasForecast = {
  predictedBaseFee: 20000000000n, // 20 gwei
  predictedPriority: 5000000000n, // 5 gwei
  volatility: 0.3,
  dynamicPriorityPct: 15,
  lastUpdate: Date.now()
};

const result = calculateNetProfit(amountIn, buyQuote, sellQuote, gasForecast, ethPrice);

console.log('Bid Math Test:', {
  grossProfit: (Number(sellQuote - amountIn) / 1e6).toFixed(2) + ' USDC',
  netProfit: (Number(result.netProfit) / 1e6).toFixed(2) + ' USDC',
  score: result.score + ' bps',
  shouldExecute: result.shouldExecute
});

// Expected: netProfit should be NEGATIVE (gas costs more than profit)
if (!result.shouldExecute && result.netProfit < 0n) {
  console.log('✅ Bid math correctly rejects unprofitable trade');
} else {
  console.log('❌ BUG: Bid math accepts losing trade!');
}
"

# Expected: shouldExecute = false, netProfit < 0
# ❌ If accepts trade -> BID MATH BUG
```

### Test 4: Supabase Logging
```bash
node -e "
const { initSupabase, logOpportunity } = require('./dist/infrastructure/supabaseLogger');

(async () => {
  initSupabase();
  
  await logOpportunity({
    block_number: 12345,
    token_in: '0xusdcaddress',
    token_out: '0xwethaddress',
    dex_buy: 'uniswap',
    dex_sell: 'sushiswap',
    amount_in_usdc: '1000000000',
    expected_profit_usdc: '5000000',
    score_bps: 50,
    quotes_json: {},
    slippage_estimate_bps: 10,
    gas_cost_wei: '7000000000000000',
    status: 'detected'
  });
  
  console.log('✅ Logged to Supabase (check dashboard)');
})();
"

# Expected: Row appears in Supabase 'opportunities' table
# ❌ If error -> Check Supabase credentials
```

---

## Phase 2: Integration Testing

### Test 5: Full Bot DRY_RUN (30 minutes)
```bash
# Run bot in dry run mode
DRY_RUN=true node dist/ApexPredator.js

# Watch for:
# [WSS] Connected ✅
# [CONTRACTS] Loaded ✅
# Bot is LIVE - Listening... ✅
# [OPPORTUNITY] Found! (may not happen on Sepolia) ⚠️
# [DRY_RUN] Would execute trade ✅

# Let run for 30 minutes
# Expected behavior:
# - No crashes
# - WSS stays connected
# - Gas forecasts update every ~12s
# - Logs opportunities to Supabase (if any detected)
# - Never actually executes trades (DRY_RUN=true)

# Success criteria:
# ✅ Runs for 30+ minutes without crash
# ✅ No WSS disconnects
# ✅ No unhandled errors
# ❌ If crashes -> Check error logs
```

### Test 6: Circuit Breaker
```bash
# Test circuit breaker logic (manual check)
node -e "
const ethers = require('ethers');

// Simulate 50% balance loss
const initialBalance = ethers.parseEther('0.1');
const currentBalance = ethers.parseEther('0.049'); // 51% loss

const drawdown = Number((initialBalance - currentBalance) * 10000n / initialBalance);
console.log('Drawdown:', drawdown / 100, '%');

if (drawdown >= 5000) { // 50% threshold
  console.log('✅ Circuit breaker would trigger');
} else {
  console.log('❌ Circuit breaker logic broken');
}
"

# Expected: "Circuit breaker would trigger"
# ❌ If not -> Check circuit breaker logic
```

---

## Phase 3: Live Testing (1-2 hours)

### Test 7: Actual Execution (Small Amounts)
```bash
# ⚠️ ONLY after all above tests pass

# 1. Set DRY_RUN=false
echo "DRY_RUN=false" >> .env.testnet

# 2. Reduce loan size for testing
# Edit constants.ts:
# MIN_LOAN_USDC: 100n * 1000000n  // Start with just 100 USDC

# 3. Rebuild
npm run build

# 4. Run bot
node dist/ApexPredator.js

# 5. Watch for actual trades
# [OPPORTUNITY] Found! Score: X bps
# [BUNDLE] Trying flashbots...
# [BUNDLE] ✅ simulation succeeded
# [BUNDLE] 📤 Submitted to flashbots...
# [SUCCESS] Trade executed via flashbots

# Success criteria:
# ✅ At least 1 SIM OK logged
# ✅ Bundle simulation succeeds
# ✅ No reverts
# ✅ Balance changes correctly
```

---

## Phase 4: Monitoring & Metrics

### Test 8: Dashboard Visualization
```bash
# 1. Open dashboard.html in browser
# file:///path/to/dashboard.html

# OR serve it:
python3 -m http.server 8000
# Then visit: http://localhost:8000/dashboard.html

# 2. Click "Refresh Data"

# Expected:
# ✅ Charts load
# ✅ Shows bot status
# ✅ Displays metrics
# ✅ Logs appear
```

### Test 9: Supabase Query Check
```sql
-- Run in Supabase SQL editor

-- Check opportunities logged in last hour
SELECT 
  COUNT(*) as total,
  status,
  AVG(score_bps) as avg_score,
  SUM(CAST(expected_profit_usdc AS NUMERIC)) / 1e6 as total_profit
FROM opportunities
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY status;

-- Check for any trades
SELECT * FROM trades
ORDER BY created_at DESC
LIMIT 10;

-- Builder performance
SELECT 
  builder_name,
  COUNT(*) as attempts,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes,
  ROUND(100.0 * SUM(CASE WHEN success THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
FROM builder_stats
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY builder_name;
```

---

## Phase 5: Mainnet Readiness Checklist

Before deploying to mainnet:

### Security
- [ ] Alchemy key rotated (never exposed)
- [ ] Private key in .env.mainnet (NEW wallet, never exposed)
- [ ] VPN confirmed working (whatismyipaddress.com)
- [ ] No private keys in git history
- [ ] .env files in .gitignore

### Financial
- [ ] Wallet funded with ≥0.5 ETH
- [ ] Circuit breaker threshold set (50% default)
- [ ] Initial balance recorded
- [ ] Ryvynn charity wallet configured (60% profit split)

### Technical
- [ ] All Sepolia tests passed
- [ ] ≥1 successful SIM OK logged
- [ ] Circuit breaker tested
- [ ] WSS stayed connected 24+ hours
- [ ] No memory leaks observed

### Configuration
- [ ] Update constants.ts with mainnet addresses
- [ ] Enable mainnet builders (Flashbots, Titan, Beaver)
- [ ] Set MIN_PROFIT_BPS appropriately (50+ for mainnet)
- [ ] Configure Telegram alerts
- [ ] Set up Supabase production instance

### Monitoring
- [ ] Dashboard accessible
- [ ] Telegram bot configured
- [ ] Supabase logging working
- [ ] PM2 or systemd for auto-restart
- [ ] Log rotation configured

---

## Emergency Procedures

### If Bot Crashes
1. Check logs: `tail -100 bot.log`
2. Check Supabase for last opportunity
3. Check wallet balance
4. Restart with DRY_RUN=true first
5. If circuit breaker triggered -> Review trades before restart

### If Wallet Drained
1. STOP BOT IMMEDIATELY
2. Check Etherscan for all transactions
3. Review Supabase trades table
4. Check for contract exploit
5. Rotate all keys
6. Post-mortem analysis before redeploying

### If No Opportunities Detected (24h)
1. Check if WSS still connected
2. Verify gas prices not extremely high
3. Check DEX liquidity on Etherscan
4. Reduce MIN_PROFIT_BPS threshold
5. Add more token pairs

---

## Success Metrics (Mainnet)

### Week 1 Goals
- [ ] 0 crashes
- [ ] >90% WSS uptime
- [ ] ≥10 opportunities detected
- [ ] ≥1 profitable trade executed
- [ ] Net positive after gas costs

### Month 1 Goals
- [ ] $500+ cumulative profit
- [ ] >95% WSS uptime
- [ ] >50% trade success rate
- [ ] 60% donated to Ryvynn
- [ ] Circuit breaker never triggered

---

## 📊 Performance Benchmarks

Expected testnet performance:
- **Opportunities**: 5-20 per day (Sepolia has low activity)
- **Profitable trades**: 0-2 per day (limited liquidity)
- **WSS uptime**: >99%
- **Gas cost**: $0.10-0.50 per attempt

Expected mainnet performance:
- **Opportunities**: 50-200 per day
- **Profitable trades**: 5-30 per day
- **Average profit**: $10-50 per trade
- **Daily profit**: $90-450 (at scale)

---

Built with 🎯 precision. Test rigorously. Deploy confidently.
