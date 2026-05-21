// filepath: internal/dex/router.go
package dex

import (
	"context"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
)

// Router aggregates multiple DEX adapters and returns the best quote.
type Router struct {
	dexes  []DEX
	logger *zap.Logger
}

// NewRouter creates a Router with all supported DEX adapters.
func NewRouter(dexes []DEX, logger *zap.Logger) *Router {
	return &Router{dexes: dexes, logger: logger}
}

// BestQuote queries all DEXes concurrently and returns the pool + amount with the highest output.
func (r *Router) BestQuote(ctx context.Context, tokenIn, tokenOut common.Address, amountIn *big.Int) (*types.Quote, error) {
	type result struct {
		quote *types.Quote
		err   error
	}
	ch := make(chan result)

	for _, d := range r.dexes {
		go func(dex DEX) {
			pools, err := dex.GetPools(ctx, tokenIn, tokenOut)
			if err != nil || len(pools) == 0 {
				ch <- result{err: err}
				return
			}
			// Try all pools of this DEX, pick best
			var best *types.Quote
			for _, pool := range pools {
				out, err := dex.GetQuote(ctx, pool, tokenIn, amountIn)
				if err != nil || out == nil || out.Sign() == 0 {
					continue
				}
				if best == nil || out.Cmp(best.AmountOut) > 0 {
					p := pool // capture
					best = &types.Quote{AmountOut: out, Pool: p}
				}
			}
			ch <- result{quote: best}
		}(d)
	}

	var best *types.Quote
	for range r.dexes {
		res := <-ch
		if res.err != nil {
			r.logger.Debug("dex quote error", zap.Error(res.err))
			continue
		}
		if res.quote == nil {
			continue
		}
		if best == nil || res.quote.AmountOut.Cmp(best.AmountOut) > 0 {
			best = res.quote
		}
	}
	if best == nil {
		return nil, nil
	}
	return best, nil
}

// AllPools returns all pools across all DEXes for the given token pair.
func (r *Router) AllPools(ctx context.Context, tokenA, tokenB common.Address) []types.Pool {
	var mu sync.Mutex
	var all []types.Pool
	var wg sync.WaitGroup
	for _, d := range r.dexes {
		wg.Add(1)
		go func(dex DEX) {
			defer wg.Done()
			pools, err := dex.GetPools(ctx, tokenA, tokenB)
			if err != nil {
				return
			}
			mu.Lock()
			all = append(all, pools...)
			mu.Unlock()
		}(d)
	}
	wg.Wait()
	return all
}

// BuildSwapStep delegates to the appropriate DEX adapter.
func (r *Router) BuildSwapStep(pool types.Pool, tokenIn common.Address, amountIn, minAmountOut *big.Int) types.SwapStep {
	for _, d := range r.dexes {
		switch pool.Type {
		case types.PoolTypeUniswapV3:
			if d.Name() == "uniswap_v3" {
				return d.BuildSwapStep(pool, tokenIn, amountIn, minAmountOut)
			}
		case types.PoolTypeAerodromeVol, types.PoolTypeAerodromeStb:
			if d.Name() == "aerodrome" {
				return d.BuildSwapStep(pool, tokenIn, amountIn, minAmountOut)
			}
		}
	}
	// Fallback: Uniswap V3 style
	return r.dexes[0].BuildSwapStep(pool, tokenIn, amountIn, minAmountOut)
}

// GetQuoteForPool returns a quote from the DEX that owns this pool.
func (r *Router) GetQuoteForPool(ctx context.Context, pool types.Pool, tokenIn common.Address, amountIn *big.Int) (*big.Int, error) {
	for _, d := range r.dexes {
		switch pool.Type {
		case types.PoolTypeUniswapV3:
			if d.Name() == "uniswap_v3" {
				return d.GetQuote(ctx, pool, tokenIn, amountIn)
			}
		case types.PoolTypeAerodromeVol, types.PoolTypeAerodromeStb:
			if d.Name() == "aerodrome" {
				return d.GetQuote(ctx, pool, tokenIn, amountIn)
			}
		}
	}
	return r.dexes[0].GetQuote(ctx, pool, tokenIn, amountIn)
}
