// filepath: internal/dex/client.go
package dex

import (
	"context"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
)

// DEX is the interface every exchange adapter must implement.
type DEX interface {
	// Name returns a human-readable identifier (e.g. "uniswap_v3", "aerodrome").
	Name() string

	// GetPools returns all pools containing both tokenA and tokenB.
	GetPools(ctx context.Context, tokenA, tokenB common.Address) ([]types.Pool, error)

	// GetQuote returns the expected output amount for an exact-input swap.
	GetQuote(ctx context.Context, pool types.Pool, tokenIn common.Address, amountIn *big.Int) (*big.Int, error)

	// BuildSwapStep returns the SwapStep calldata struct for the FlashLoan contract.
	BuildSwapStep(pool types.Pool, tokenIn common.Address, amountIn, minAmountOut *big.Int) types.SwapStep
}

// BaseTokens lists the canonical token addresses on Base mainnet.
var BaseTokens = struct {
	USDC  common.Address
	WETH  common.Address
	USDT  common.Address
	DAI   common.Address
	cbBTC common.Address
	cbETH common.Address
	AERO  common.Address
}{
	USDC:  common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
	WETH:  common.HexToAddress("0x4200000000000000000000000000000000000006"),
	USDT:  common.HexToAddress("0xfde4C96c8593536E31F0E8c0FFF4E4b5770B80EC"),
	DAI:   common.HexToAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"),
	cbBTC: common.HexToAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"),
	cbETH: common.HexToAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"),
	AERO:  common.HexToAddress("0x940181a94A35A4569E4529A3CDfB74e38FD98631"),
}

// AllBaseTokens returns the full token list for graph construction.
func AllBaseTokens() []types.Token {
	return []types.Token{
		{Address: BaseTokens.USDC,  Symbol: "USDC",  Decimals: 6},
		{Address: BaseTokens.WETH,  Symbol: "WETH",  Decimals: 18},
		{Address: BaseTokens.USDT,  Symbol: "USDT",  Decimals: 6},
		{Address: BaseTokens.DAI,   Symbol: "DAI",   Decimals: 18},
		{Address: BaseTokens.cbBTC, Symbol: "cbBTC", Decimals: 8},
		{Address: BaseTokens.cbETH, Symbol: "cbETH", Decimals: 18},
		{Address: BaseTokens.AERO,  Symbol: "AERO",  Decimals: 18},
	}
}
