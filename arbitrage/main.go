// filepath: main.go
package main

import (
	"context"
	"fmt"
	"math/big"
	"math/rand"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/config"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/arbitrage"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/dex"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/flashloan"
	arblogger "github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/logger"
	arbtypes "github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

const (
	BaseChainID     = 8453
	GraphRebuildEvery = 120 // rebuild pool graph every N scans
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}

	logger := buildLogger(cfg.LogLevel)
	defer logger.Sync() //nolint:errcheck

	logger.Info("Apex Predator Go — starting",
		zap.Int("chain_id", BaseChainID),
		zap.Bool("dry_run", cfg.DryRun),
		zap.Int("rpc_count", len(cfg.RPCURLs)),
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// ── RPC client pool ──────────────────────────────────────────────────────
	clients := make([]*ethclient.Client, 0, len(cfg.RPCURLs))
	for _, url := range cfg.RPCURLs {
		c, err := ethclient.DialContext(ctx, url)
		if err != nil {
			logger.Warn("failed to connect to RPC", zap.String("url", url), zap.Error(err))
			continue
		}
		clients = append(clients, c)
	}
	if len(clients) == 0 {
		logger.Fatal("no usable RPC connections")
	}
	defer func() {
		for _, c := range clients {
			c.Close()
		}
	}()

	var rpcIdx atomic.Uint32
	nextClient := func() *ethclient.Client {
		idx := rpcIdx.Add(1) - 1
		return clients[int(idx)%len(clients)]
	}

	// ── DEX adapters ─────────────────────────────────────────────────────────
	uniV3, err := dex.NewUniswapV3(nextClient())
	if err != nil {
		logger.Fatal("uniswap init", zap.Error(err))
	}
	aero, err := dex.NewAerodrome(nextClient())
	if err != nil {
		logger.Fatal("aerodrome init", zap.Error(err))
	}
	router := dex.NewRouter([]dex.DEX{uniV3, aero}, logger)

	// ── Triangle detector ─────────────────────────────────────────────────────
	tokens := dex.AllBaseTokens()
	detector := arbitrage.NewDetector(router, tokens, logger)

	logger.Info("building initial pool graph…")
	if err := detector.RebuildGraph(ctx); err != nil {
		logger.Fatal("initial graph build failed", zap.Error(err))
	}

	// ── Flash loan executor ───────────────────────────────────────────────────
	flExec, err := flashloan.NewExecutor(
		nextClient(),
		common.HexToAddress(cfg.FlashLoanContract),
		cfg.PrivateKey,
		cfg.GasLimitArb,
		big.NewInt(BaseChainID),
		logger,
	)
	if err != nil {
		logger.Fatal("flash loan executor init", zap.Error(err))
	}

	exec := arbitrage.NewExecutor(cfg, flExec, nextClient(), logger)

	// ── Gas cost estimate in USDC micro-units ────────────────────────────────
	// 600_000 gas × ~0.01 gwei base fee on Base × $3000/ETH ≈ $0.018
	// Use a conservative $0.05 = 50_000 USDC units as the gas cost floor.
	gasCostBase := big.NewInt(50_000)

	minProfit := big.NewInt(cfg.MinProfitUSDC)

	// Loan size range for ternary search: $1K → $100K
	// Gas is ~$0.05 fixed — profit scales linearly with loan size until slippage bites.
	loanMin := new(big.Int).Mul(big.NewInt(1_000),   big.NewInt(1_000_000))
	loanMax := new(big.Int).Mul(big.NewInt(100_000), big.NewInt(1_000_000))

	// ── Main scan loop ───────────────────────────────────────────────────────
	ticker := time.NewTicker(cfg.ScanInterval)
	defer ticker.Stop()

	var scanCount uint64
	logger.Info("bot LIVE — scanning for profitable cycles",
		zap.String("base_token", "USDC"),
		zap.String("loan_range", "$1K–$100K (ternary optimized)"),
		zap.Int64("min_profit_usdc_units", cfg.MinProfitUSDC),
	)
	arblogger.TelegramStartup()

	// Gas balance monitor — alerts every hour if wallet is low
	gasWarnWei      := new(big.Int).Mul(big.NewInt(50_000_000_000_000_000), big.NewInt(1)) // 0.05 ETH
	gasCriticalWei  := new(big.Int).Mul(big.NewInt(20_000_000_000_000_000), big.NewInt(1)) // 0.02 ETH
	lastGasAlert    := time.Time{}
	gasAlertCooldown := time.Hour

	// Derive wallet address from private key for gas monitoring
	pkBytes, _ := crypto.HexToECDSA(strings.TrimPrefix(cfg.PrivateKey, "0x"))
	walletAddr  := crypto.PubkeyToAddress(pkBytes.PublicKey)

	go func() {
		gasTicker := time.NewTicker(5 * time.Minute)
		defer gasTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-gasTicker.C:
				bal, err := nextClient().BalanceAt(ctx, walletAddr, nil)
				if err != nil || time.Since(lastGasAlert) < gasAlertCooldown {
					continue
				}
				if bal.Cmp(gasCriticalWei) < 0 {
					lastGasAlert = time.Now()
					arblogger.TelegramError(fmt.Sprintf("⛽ CRITICAL: gas wallet at %.4f ETH — bot will stall soon. Send ETH immediately.", toEth(bal)))
					logger.Warn("gas critical", zap.String("balance_eth", fmt.Sprintf("%.4f", toEth(bal))))
				} else if bal.Cmp(gasWarnWei) < 0 {
					lastGasAlert = time.Now()
					arblogger.TelegramError(fmt.Sprintf("⛽ Low gas: %.4f ETH remaining. Top up to keep bot running.", toEth(bal)))
					logger.Warn("gas low", zap.String("balance_eth", fmt.Sprintf("%.4f", toEth(bal))))
				}
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			logger.Info("shutting down")
			return

		case <-ticker.C:
			scanCount++

			// Rotate RPC every N scans (anti-detection)
			if scanCount%uint64(cfg.RPCRotateEvery) == 0 {
				rpcIdx.Add(1)
			}

			// Rebuild graph periodically to pick up new pools
			if scanCount%GraphRebuildEvery == 0 {
				go func() {
					rebuildCtx, done := context.WithTimeout(ctx, 30*time.Second)
					defer done()
					if err := detector.RebuildGraph(rebuildCtx); err != nil {
						logger.Warn("graph rebuild failed", zap.Error(err))
					}
				}()
			}

			// Random jitter (anti-detection)
			if cfg.MaxJitterMS > 0 {
				jitter := time.Duration(rand.Intn(cfg.MaxJitterMS)) * time.Millisecond
				time.Sleep(jitter)
			}

			// Find cycles at min loan first (fast probe)
			scanCtx, done := context.WithTimeout(ctx, 4*time.Second)
			cycles, err := detector.FindCycles(scanCtx, dex.BaseTokens.USDC, loanMin, gasCostBase, minProfit)
			done()

			if err != nil {
				logger.Warn("cycle detection error", zap.Error(err))
				continue
			}
			if len(cycles) == 0 {
				continue
			}

			// Best cycle confirmed at $1K — find optimal loan size via ternary search
			bestCycle := cycles[0]
			optimalLoan := findOptimalLoanSize(ctx, detector, bestCycle, loanMin, loanMax, gasCostBase, minProfit)
			if optimalLoan.Cmp(loanMin) > 0 {
				// Re-simulate at optimal size to get accurate steps and PnL
				optCtx, optDone := context.WithTimeout(ctx, 4*time.Second)
				optCycles, optErr := detector.FindCycles(optCtx, dex.BaseTokens.USDC, optimalLoan, gasCostBase, minProfit)
				optDone()
				if optErr == nil && len(optCycles) > 0 {
					bestCycle = optCycles[0]
				}
			}

			// Stamp quote freshness immediately after simulation completes.
			quotedBest := &arbitrage.QuotedCycle{Cycle: bestCycle, QuotedAt: time.Now()}

			logger.Info("executing best cycle",
				zap.String("path", bestCycle.Tokens[0].Symbol+"→"+bestCycle.Tokens[1].Symbol+"→"+bestCycle.Tokens[2].Symbol),
				zap.String("loan", bestCycle.AmountIn.String()),
				zap.String("net_pnl", bestCycle.NetPnLUSDC.String()),
			)

			// Reject stale quotes — a new block may have shifted prices.
			if !quotedBest.IsFresh() {
				logger.Warn("quote stale, skipping execution",
					zap.Int64("age_ms", quotedBest.AgeMs()),
				)
				continue
			}
			if quotedBest.IsWarnAge() {
				logger.Warn("quote near expiry, proceeding with caution",
					zap.Int64("age_ms", quotedBest.AgeMs()),
				)
			}

			// Execute only the best cycle per scan to avoid nonce conflicts
			execCtx, execDone := context.WithTimeout(ctx, 10*time.Second)
			if err := exec.Execute(execCtx, bestCycle); err != nil {
				logger.Error("execution error", zap.Error(err))
			}
			execDone()
		}
	}
}

func toEth(wei *big.Int) float64 {
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(wei), big.NewFloat(1e18)).Float64()
	return f
}

func buildLogger(level string) *zap.Logger {
	lvl := zapcore.InfoLevel
	_ = lvl.UnmarshalText([]byte(strings.ToLower(level)))
	cfg := zap.NewProductionConfig()
	cfg.Level = zap.NewAtomicLevelAt(lvl)
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	l, _ := cfg.Build()
	return l
}

// findOptimalLoanSize uses ternary search (6 iterations) to find the loan size that
// maximises NetPnLUSDC for a given cycle path. Returns loanMin if no improvement found.
func findOptimalLoanSize(
	ctx context.Context,
	detector *arbitrage.Detector,
	sample *arbtypes.Cycle,
	loanMin, loanMax, gasCost, minProfit *big.Int,
) *big.Int {
	tokens := [3]common.Address{
		sample.Tokens[0].Address,
		sample.Tokens[1].Address,
		sample.Tokens[2].Address,
	}

	bestPnL := func(size *big.Int) *big.Int {
		tCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		cycles, err := detector.FindCycles(tCtx, tokens[0], size, gasCost, minProfit)
		if err != nil || len(cycles) == 0 {
			return new(big.Int)
		}
		// find the cycle matching our token path
		for _, c := range cycles {
			if c.Tokens[1].Address == tokens[1] && c.Tokens[2].Address == tokens[2] {
				return c.NetPnLUSDC
			}
		}
		return cycles[0].NetPnLUSDC
	}

	lo := new(big.Int).Set(loanMin)
	hi := new(big.Int).Set(loanMax)
	for i := 0; i < 6; i++ {
		span := new(big.Int).Sub(hi, lo)
		m1 := new(big.Int).Add(lo, new(big.Int).Div(span, big.NewInt(3)))
		m2 := new(big.Int).Sub(hi, new(big.Int).Div(span, big.NewInt(3)))
		if bestPnL(m1).Cmp(bestPnL(m2)) >= 0 {
			hi = m2
		} else {
			lo = m1
		}
	}
	optimal := new(big.Int).Div(new(big.Int).Add(lo, hi), big.NewInt(2))
	if optimal.Cmp(loanMin) < 0 {
		return loanMin
	}
	return optimal
}
