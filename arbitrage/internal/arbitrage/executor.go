// filepath: internal/arbitrage/executor.go
package arbitrage

import (
	"context"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/config"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/flashloan"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
)

// Executor decides whether to execute a cycle and fires the flash loan.
type Executor struct {
	cfg      *config.Config
	fl       *flashloan.Executor
	client   *ethclient.Client
	logger   *zap.Logger
}

// NewExecutor creates an Executor.
func NewExecutor(cfg *config.Config, fl *flashloan.Executor, client *ethclient.Client, logger *zap.Logger) *Executor {
	return &Executor{cfg: cfg, fl: fl, client: client, logger: logger}
}

// Execute evaluates and optionally fires a flash loan for the best cycle.
func (e *Executor) Execute(ctx context.Context, cycle *types.Cycle) error {
	minProfit := big.NewInt(e.cfg.MinProfitUSDC)
	if cycle.NetPnLUSDC.Cmp(minProfit) < 0 {
		e.logger.Debug("cycle below min profit threshold",
			zap.String("net_pnl", cycle.NetPnLUSDC.String()),
			zap.String("min", minProfit.String()),
		)
		return nil
	}

	e.logger.Info("profitable cycle found",
		zap.String("path", cyclePath(cycle)),
		zap.String("amount_in", cycle.AmountIn.String()),
		zap.String("amount_out", cycle.AmountOut.String()),
		zap.String("net_pnl_usdc_units", cycle.NetPnLUSDC.String()),
	)

	if e.cfg.DryRun {
		e.logger.Info("[DRY RUN] would execute flash loan — skipping")
		return nil
	}

	start := time.Now()
	txHash, err := e.fl.Execute(ctx, cycle)
	elapsed := time.Since(start)

	if err != nil {
		e.logger.Error("flash loan execution failed",
			zap.Error(err),
			zap.Duration("elapsed", elapsed),
		)
		return err
	}

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
