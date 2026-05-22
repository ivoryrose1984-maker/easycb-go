// filepath: internal/arbitrage/executor.go
package arbitrage

import (
	"context"
	"math/big"
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
	// Gate on max gas price to avoid executing during fee spikes
	if e.cfg.MaxGasGwei > 0 {
		if head, err := e.client.HeaderByNumber(ctx, nil); err == nil && head.BaseFee != nil {
			baseFeeGwei, _ := new(big.Float).Quo(
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

	minProfit := big.NewInt(e.cfg.MinProfitUSDC)
	if cycle.NetPnLUSDC.Cmp(minProfit) < 0 {
		e.logger.Debug("cycle below min profit threshold",
			zap.String("net_pnl", cycle.NetPnLUSDC.String()),
			zap.String("min", minProfit.String()),
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
		return err
	}

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
