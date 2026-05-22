// filepath: internal/arbitrage/triangle.go
package arbitrage

import (
	"context"
	"fmt"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/dex"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
)

// graph maps tokenAddr -> list of (neighborToken, pool) edges.
type edge struct {
	Neighbor common.Address
	Pool     types.Pool
}
type graph map[common.Address][]edge

// Detector finds profitable 3-token arbitrage cycles.
type Detector struct {
	router   *dex.Router
	tokens   []types.Token
	logger   *zap.Logger

	mu    sync.RWMutex
	graph graph // rebuilt each scan
}

// NewDetector creates a Detector.
func NewDetector(router *dex.Router, tokens []types.Token, logger *zap.Logger) *Detector {
	return &Detector{router: router, tokens: tokens, logger: logger}
}

// RebuildGraph fetches all pools for all token pairs and constructs the adjacency graph.
// Call this periodically (e.g. every 60s) to pick up new pools.
func (d *Detector) RebuildGraph(ctx context.Context) error {
	g := make(graph)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < len(d.tokens); i++ {
		for j := i + 1; j < len(d.tokens); j++ {
			wg.Add(1)
			go func(a, b types.Token) {
				defer wg.Done()
				pools := d.router.AllPools(ctx, a.Address, b.Address)
				mu.Lock()
				defer mu.Unlock()
				for _, p := range pools {
					p0, p1 := p.Token0.Address, p.Token1.Address
					g[p0] = append(g[p0], edge{Neighbor: p1, Pool: p})
					g[p1] = append(g[p1], edge{Neighbor: p0, Pool: p})
				}
			}(d.tokens[i], d.tokens[j])
		}
	}
	wg.Wait()

	d.mu.Lock()
	d.graph = g
	d.mu.Unlock()

	d.logger.Info("graph rebuilt",
		zap.Int("nodes", len(g)),
		zap.Int("tokens", len(d.tokens)),
	)
	return nil
}

// FindCycles discovers all 3-token cycles starting from baseToken (usually USDC)
// and simulates each with amountIn to find profitable ones.
func (d *Detector) FindCycles(
	ctx context.Context,
	baseToken common.Address,
	amountIn *big.Int,
	gasCostBase *big.Int, // estimated gas cost in baseToken units
	minNetProfit *big.Int,
) ([]*types.Cycle, error) {
	d.mu.RLock()
	g := d.graph
	d.mu.RUnlock()

	if len(g) == 0 {
		return nil, fmt.Errorf("graph is empty — call RebuildGraph first")
	}

	// DFS: find all paths [base, mid, end] where end has edge back to base
	type path struct {
		tokens [3]common.Address
		pools  [2]types.Pool // first two edges; third found in loop
	}
	var candidates []path
	seen := make(map[string]bool)

	for _, e1 := range g[baseToken] {
		mid := e1.Neighbor
		if mid == baseToken {
			continue
		}
		for _, e2 := range g[mid] {
			end := e2.Neighbor
			if end == baseToken || end == mid {
				continue
			}
			// Check if end connects back to base
			for _, e3 := range g[end] {
				if e3.Neighbor != baseToken {
					continue
				}
				// Deduplicate: sort tokens to canonical key
				key := cycleKey(baseToken, mid, end)
				if seen[key] {
					continue
				}
				seen[key] = true
				candidates = append(candidates, path{
					tokens: [3]common.Address{baseToken, mid, end},
					pools:  [2]types.Pool{e1.Pool, e2.Pool},
				})
			}
		}
	}

	d.logger.Debug("candidate cycles found", zap.Int("count", len(candidates)))

	// Simulate each candidate concurrently
	type simResult struct {
		cycle *types.Cycle
		err   error
	}
	results := make(chan simResult, len(candidates))

	for _, c := range candidates {
		go func(p path) {
			cycle, err := d.simulateCycle(ctx, p.tokens, amountIn, gasCostBase, minNetProfit)
			results <- simResult{cycle: cycle, err: err}
		}(c)
	}

	var profitable []*types.Cycle
	for range candidates {
		res := <-results
		if res.err != nil {
			d.logger.Debug("simulation error", zap.Error(res.err))
			continue
		}
		if res.cycle != nil && res.cycle.Profitable() {
			profitable = append(profitable, res.cycle)
		}
	}

	// Sort by NetPnL descending
	sortCycles(profitable)
	return profitable, nil
}

// simulateCycle fetches real quotes for a 3-hop path and returns a Cycle if profitable.
func (d *Detector) simulateCycle(
	ctx context.Context,
	tokens [3]common.Address,
	amountIn *big.Int,
	gasCostBase *big.Int,
	minNetProfit *big.Int,
) (*types.Cycle, error) {
	// Leg 1: tokens[0] → tokens[1]
	q1, err := d.router.BestQuote(ctx, tokens[0], tokens[1], amountIn)
	if err != nil || q1 == nil || q1.AmountOut.Sign() == 0 {
		return nil, nil
	}

	// Leg 2: tokens[1] → tokens[2]
	q2, err := d.router.BestQuote(ctx, tokens[1], tokens[2], q1.AmountOut)
	if err != nil || q2 == nil || q2.AmountOut.Sign() == 0 {
		return nil, nil
	}

	// Leg 3: tokens[2] → tokens[0]
	q3, err := d.router.BestQuote(ctx, tokens[2], tokens[0], q2.AmountOut)
	if err != nil || q3 == nil || q3.AmountOut.Sign() == 0 {
		return nil, nil
	}

	gross := new(big.Int).Sub(q3.AmountOut, amountIn) // can be negative
	net := new(big.Int).Sub(gross, gasCostBase)

	if net.Cmp(minNetProfit) < 0 {
		return nil, nil
	}

	// Apply 0.5% slippage tolerance to minAmountOut for each step
	slip := func(amt *big.Int) *big.Int {
		return new(big.Int).Div(new(big.Int).Mul(amt, big.NewInt(995)), big.NewInt(1000))
	}

	tok := func(addr common.Address) types.Token {
		for _, t := range dex.AllBaseTokens() {
			if t.Address == addr {
				return t
			}
		}
		return types.Token{Address: addr}
	}

	return &types.Cycle{
		Tokens:     [3]types.Token{tok(tokens[0]), tok(tokens[1]), tok(tokens[2])},
		Pools:      [3]types.Pool{q1.Pool, q2.Pool, q3.Pool},
		Steps: [3]types.SwapStep{
			d.router.BuildSwapStep(q1.Pool, tokens[0], amountIn, slip(q1.AmountOut)),
			d.router.BuildSwapStep(q2.Pool, tokens[1], q1.AmountOut, slip(q2.AmountOut)),
			d.router.BuildSwapStep(q3.Pool, tokens[2], q2.AmountOut, slip(q3.AmountOut)),
		},
		AmountIn:   new(big.Int).Set(amountIn),
		AmountOut:  new(big.Int).Set(q3.AmountOut),
		GrossPnL:   new(big.Int).Set(gross),
		GasCostEst: new(big.Int).Set(gasCostBase),
		NetPnLUSDC: new(big.Int).Set(net),
	}, nil
}

func cycleKey(a, b, c common.Address) string {
	addrs := []string{a.Hex(), b.Hex(), c.Hex()}
	// Simple canonical order
	if addrs[1] < addrs[0] {
		addrs[0], addrs[1] = addrs[1], addrs[0]
	}
	if addrs[2] < addrs[1] {
		addrs[1], addrs[2] = addrs[2], addrs[1]
	}
	if addrs[1] < addrs[0] {
		addrs[0], addrs[1] = addrs[1], addrs[0]
	}
	return addrs[0] + addrs[1] + addrs[2]
}

func sortCycles(cycles []*types.Cycle) {
	for i := 1; i < len(cycles); i++ {
		for j := i; j > 0 && cycles[j].NetPnLUSDC.Cmp(cycles[j-1].NetPnLUSDC) > 0; j-- {
			cycles[j], cycles[j-1] = cycles[j-1], cycles[j]
		}
	}
}
