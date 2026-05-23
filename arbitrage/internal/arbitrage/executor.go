// filepath: internal/arbitrage/executor.go
package arbitrage

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/config"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/flashloan"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/logger"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
)

var weiPerGwei = new(big.Float).SetInt(big.NewInt(1_000_000_000))

// Executor decides whether to execute a cycle and fires the flash loan.
type Executor struct {
	cfg    *config.Config
	fl     *flashloan.Executor
	client *ethclient.Client
	logger *zap.Logger

	// circuit breaker state
	cbMu          sync.Mutex
	cbFailures    int
	cbPausedUntil time.Time
}

// NewExecutor creates an Executor.
func NewExecutor(cfg *config.Config, fl *flashloan.Executor, client *ethclient.Client, logger *zap.Logger) *Executor {
	return &Executor{cfg: cfg, fl: fl, client: client, logger: logger}
}

// isBreakerOpen returns true when the circuit breaker is tripped and the cooldown
// period has not yet elapsed.
func (e *Executor) isBreakerOpen() bool {
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	return time.Now().Before(e.cbPausedUntil)
}

func (e *Executor) recordFailure() {
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	e.cbFailures++
	if e.cbFailures >= e.cfg.MaxConsecutiveFailures {
		cooldown := time.Duration(e.cfg.FailureCooldownSeconds) * time.Second
		e.cbPausedUntil = time.Now().Add(cooldown)
		e.cbFailures = 0
		e.logger.Warn("circuit breaker opened",
			zap.Duration("cooldown", cooldown),
		)
	}
}

func (e *Executor) recordSuccess() {
	e.cbMu.Lock()
	defer e.cbMu.Unlock()
	e.cbFailures = 0
}

// Execute evaluates and optionally fires a flash loan for the best cycle.
// currentBlock is the block number at which the caller fetched quotes; pass 0 to
// skip block-freshness checking (time-based staleness still applies upstream).
func (e *Executor) Execute(ctx context.Context, cycle *types.Cycle, currentBlock ...uint64) error {
	// ── Circuit breaker ───────────────────────────────────────────────────────
	if e.isBreakerOpen() {
		e.logger.Warn("circuit breaker open — skipping execution")
		return nil
	}

	// ── Gas price gate ────────────────────────────────────────────────────────
	var baseFeeGwei float64
	if e.cfg.MaxGasGwei > 0 {
		if head, err := e.client.HeaderByNumber(ctx, nil); err == nil && head.BaseFee != nil {
			baseFeeGwei, _ = new(big.Float).Quo(
				new(big.Float).SetInt(head.BaseFee), weiPerGwei,
			).Float64()
			if baseFeeGwei > e.cfg.MaxGasGwei {
				e.logger.Info("base fee above max — skipping cycle",
					zap.Float64("base_fee_gwei", baseFeeGwei),
					zap.Float64("max_gas_gwei", e.cfg.MaxGasGwei),
				)
				return nil
			}
		}
	}

	// ── Block freshness check ─────────────────────────────────────────────────
	if len(currentBlock) > 0 && currentBlock[0] > 0 && cycle.QuoteBlock > 0 {
		blockAge := currentBlock[0] - cycle.QuoteBlock
		if blockAge > e.cfg.MaxQuoteBlockAge {
			e.logger.Warn("quote too old — skipping cycle",
				zap.Uint64("quote_block", cycle.QuoteBlock),
				zap.Uint64("current_block", currentBlock[0]),
				zap.Uint64("age_blocks", blockAge),
				zap.Uint64("max_age", e.cfg.MaxQuoteBlockAge),
			)
			return nil
		}
	}

	// ── Profit safety gate ────────────────────────────────────────────────────
	// netProfit must exceed: max(MinProfitUSDC, gasCost × (10000 + ProfitSafetyBps) / 10000)
	gasCostScaled := new(big.Int).Mul(cycle.GasCostEst, big.NewInt(int64(10000+e.cfg.ProfitSafetyBps)))
	gasCostScaled.Div(gasCostScaled, big.NewInt(10000))
	minProfitDynamic := gasCostScaled
	minProfitFixed := big.NewInt(e.cfg.MinProfitUSDC)
	if minProfitFixed.Cmp(minProfitDynamic) > 0 {
		minProfitDynamic = minProfitFixed
	}
	if cycle.NetPnLUSDC.Cmp(minProfitDynamic) < 0 {
		e.logger.Debug("cycle below profit safety threshold",
			zap.String("net_pnl", cycle.NetPnLUSDC.String()),
			zap.String("min_required", minProfitDynamic.String()),
		)
		return nil
	}

	amountInF, _ := new(big.Float).SetInt(cycle.AmountIn).Float64()
	profitF, _ := new(big.Float).SetInt(cycle.NetPnLUSDC).Float64()

	e.logger.Info("profitable cycle found",
		zap.String("path", cyclePath(cycle)),
		zap.String("amount_in", cycle.AmountIn.String()),
		zap.String("amount_out", cycle.AmountOut.String()),
		zap.String("net_pnl_usdc_units", cycle.NetPnLUSDC.String()),
	)

	logger.LogOpportunity(logger.OpportunityRow{
		TokenIn:            cycle.Tokens[0].Address.Hex(),
		TokenOut:           cycle.Tokens[0].Address.Hex(),
		TokenMid:           cycle.Tokens[1].Address.Hex(),
		AmountInUSDC:       amountInF / 1e6,
		ExpectedProfitUSDC: profitF / 1e6,
		GasCostWei:         cycle.GasCostEst.String(),
		Status:             "detected",
	})

	if e.cfg.DryRun {
		e.logger.Info("[DRY RUN] would execute flash loan — skipping")
		return nil
	}

	// ── Preflight eth_call simulation ─────────────────────────────────────────
	if err := e.fl.Simulate(ctx, cycle); err != nil {
		e.logger.Warn("preflight simulation failed — aborting",
			zap.Error(err),
			zap.String("path", cyclePath(cycle)),
		)
		e.recordFailure()
		return fmt.Errorf("preflight: %w", err)
	}

	// ── Execute ───────────────────────────────────────────────────────────────
	start := time.Now()
	txHash, err := e.fl.Execute(ctx, cycle)
	elapsed := time.Since(start)

	status := "included"
	if err != nil {
		status = "failed"
		logger.LogTrade(logger.TradeRow{
			TxHash:           "",
			TokenIn:          cycle.Tokens[0].Address.Hex(),
			TokenOut:         cycle.Tokens[0].Address.Hex(),
			TokenMid:         cycle.Tokens[1].Address.Hex(),
			AmountInUSDC:     amountInF / 1e6,
			ActualProfitUSDC: 0,
			GasCostWei:       cycle.GasCostEst.String(),
			ExecutionTimeMs:  elapsed.Milliseconds(),
			Status:           status,
		})
		e.logger.Error("flash loan execution failed",
			zap.Error(err),
			zap.Duration("elapsed", elapsed),
		)
		e.recordFailure()
		return err
	}

	e.recordSuccess()

	logger.LogTrade(logger.TradeRow{
		TxHash:           txHash,
		TokenIn:          cycle.Tokens[0].Address.Hex(),
		TokenOut:         cycle.Tokens[0].Address.Hex(),
		TokenMid:         cycle.Tokens[1].Address.Hex(),
		AmountInUSDC:     amountInF / 1e6,
		ActualProfitUSDC: profitF / 1e6,
		GasCostWei:       cycle.GasCostEst.String(),
		ExecutionTimeMs:  elapsed.Milliseconds(),
		Status:           status,
	})
	logger.TelegramProfit(profitF/1e6, txHash)

	e.logger.Info("flash loan submitted",
		zap.String("tx_hash", txHash),
		zap.String("net_pnl", cycle.NetPnLUSDC.String()),
		zap.Duration("elapsed", elapsed),
	)
	return nil
}

func cyclePath(c *types.Cycle) string {
	return c.Tokens[0].Symbol + " -> " + c.Tokens[1].Symbol + " -> " + c.Tokens[2].Symbol + " -> " + c.Tokens[0].Symbol
}
