// filepath: internal/types/types.go
package types

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// Token represents an ERC-20 token.
type Token struct {
	Address  common.Address
	Symbol   string
	Decimals uint8
}

// PoolType distinguishes DEX variants.
type PoolType string

const (
	PoolTypeUniswapV3    PoolType = "uniswap_v3"
	PoolTypeAerodromeVol PoolType = "aerodrome_volatile"
	PoolTypeAerodromeStb PoolType = "aerodrome_stable"
)

// Pool represents a liquidity pool on any DEX.
type Pool struct {
	Address    common.Address
	Token0     Token
	Token1     Token
	Type       PoolType
	Fee        uint32 // basis points × 100 for UniV3 (e.g. 500 = 0.05%), 0 for Aerodrome
	DEXRouter  common.Address
	DEXFactory common.Address
}

// SwapStep is one leg of a multi-hop path, matching the Solidity struct exactly.
type SwapStep struct {
	DexRouter    common.Address
	TokenIn      common.Address
	TokenOut     common.Address
	UniV3Fee     uint32 // 0 means Aerodrome
	AeroStable   bool
	AeroFactory  common.Address
	MinAmountOut *big.Int
}

// Cycle is a profitable 3-token arbitrage loop.
type Cycle struct {
	Tokens      [3]Token
	Pools       [3]Pool
	Steps       [3]SwapStep
	AmountIn    *big.Int
	AmountOut   *big.Int   // final amount back in Tokens[0]
	GrossPnL    *big.Int   // AmountOut - AmountIn
	GasCostEst  *big.Int   // estimated gas cost in Tokens[0] units (same as AmountIn denomination)
	NetPnLUSDC  *big.Int   // after gas, denominated in Tokens[0] units
	QuoteBlock  uint64     // block number when quotes were fetched
}

// Profitable returns true when the cycle yields net profit.
func (c *Cycle) Profitable() bool {
	return c.NetPnLUSDC != nil && c.NetPnLUSDC.Sign() > 0
}

// Quote is the result of a single DEX price query.
type Quote struct {
	AmountOut *big.Int
	Pool      Pool
}
