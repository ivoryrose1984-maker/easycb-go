// filepath: internal/dex/uniswap.go
package dex

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
)

const (
	UniV3FactoryAddr = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
	UniV3QuoterAddr  = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
	UniV3RouterAddr  = "0x2626664c2603336E57B271c5C0b26F421741e481"
)

// Fee tiers supported by Uniswap V3 on Base.
var uniV3FeeTiers = []uint32{100, 500, 3000, 10000}

const uniV3FactoryABI = `[{
  "inputs":[{"type":"address"},{"type":"address"},{"type":"uint24"}],
  "name":"getPool","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"
}]`

const uniV3QuoterABI = `[{
  "inputs":[{"components":[
    {"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},
    {"name":"amountIn","type":"uint256"},{"name":"fee","type":"uint24"},
    {"name":"sqrtPriceLimitX96","type":"uint160"}
  ],"type":"tuple"}],
  "name":"quoteExactInputSingle",
  "outputs":[{"name":"amountOut","type":"uint256"},{"type":"uint160"},{"type":"uint32"},{"type":"uint256"}],
  "stateMutability":"nonpayable","type":"function"
}]`

// UniswapV3 is the Uniswap V3 DEX adapter.
type UniswapV3 struct {
	client      *ethclient.Client
	factoryABI  abi.ABI
	quoterABI   abi.ABI
	factoryAddr common.Address
	quoterAddr  common.Address
	routerAddr  common.Address
}

// NewUniswapV3 constructs the adapter.
func NewUniswapV3(client *ethclient.Client) (*UniswapV3, error) {
	fABI, err := abi.JSON(strings.NewReader(uniV3FactoryABI))
	if err != nil {
		return nil, err
	}
	qABI, err := abi.JSON(strings.NewReader(uniV3QuoterABI))
	if err != nil {
		return nil, err
	}
	return &UniswapV3{
		client:      client,
		factoryABI:  fABI,
		quoterABI:   qABI,
		factoryAddr: common.HexToAddress(UniV3FactoryAddr),
		quoterAddr:  common.HexToAddress(UniV3QuoterAddr),
		routerAddr:  common.HexToAddress(UniV3RouterAddr),
	}, nil
}

func (u *UniswapV3) Name() string { return "uniswap_v3" }

// GetPools returns all Uniswap V3 pools for a token pair across all fee tiers.
func (u *UniswapV3) GetPools(ctx context.Context, tokenA, tokenB common.Address) ([]types.Pool, error) {
	var pools []types.Pool
	for _, fee := range uniV3FeeTiers {
		data, err := u.factoryABI.Pack("getPool", tokenA, tokenB, fee)
		if err != nil {
			continue
		}
		result, err := u.client.CallContract(ctx, ethereum.CallMsg{
			To: &u.factoryAddr, Data: data,
		}, nil)
		if err != nil || len(result) == 0 {
			continue
		}
		poolAddr := common.BytesToAddress(result[12:32])
		if poolAddr == (common.Address{}) {
			continue
		}
		pools = append(pools, types.Pool{
			Address:    poolAddr,
			Token0:     types.Token{Address: tokenA},
			Token1:     types.Token{Address: tokenB},
			Type:       types.PoolTypeUniswapV3,
			Fee:        fee,
			DEXRouter:  u.routerAddr,
			DEXFactory: u.factoryAddr,
		})
	}
	return pools, nil
}

// GetQuote calls the Uniswap V3 QuoterV2 (off-chain simulation, no gas cost).
func (u *UniswapV3) GetQuote(ctx context.Context, pool types.Pool, tokenIn common.Address, amountIn *big.Int) (*big.Int, error) {
	type quoteParams struct {
		TokenIn           common.Address
		TokenOut          common.Address
		AmountIn          *big.Int
		Fee               uint32
		SqrtPriceLimitX96 *big.Int
	}
	tokenOut := pool.Token0.Address
	if tokenIn == pool.Token0.Address {
		tokenOut = pool.Token1.Address
	}
	params := quoteParams{
		TokenIn:           tokenIn,
		TokenOut:          tokenOut,
		AmountIn:          amountIn,
		Fee:               pool.Fee,
		SqrtPriceLimitX96: big.NewInt(0),
	}
	data, err := u.quoterABI.Pack("quoteExactInputSingle", params)
	if err != nil {
		return nil, fmt.Errorf("pack quoteExactInputSingle: %w", err)
	}
	result, err := u.client.CallContract(ctx, ethereum.CallMsg{
		To: &u.quoterAddr, Data: data,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("quoteExactInputSingle call: %w", err)
	}
	// First return value is amountOut (uint256)
	if len(result) < 32 {
		return nil, fmt.Errorf("short result: %d bytes", len(result))
	}
	return new(big.Int).SetBytes(result[:32]), nil
}

// BuildSwapStep returns the SwapStep struct for the flash loan contract.
func (u *UniswapV3) BuildSwapStep(pool types.Pool, tokenIn common.Address, amountIn, minAmountOut *big.Int) types.SwapStep {
	tokenOut := pool.Token0.Address
	if tokenIn == pool.Token0.Address {
		tokenOut = pool.Token1.Address
	}
	return types.SwapStep{
		DexRouter:    pool.DEXRouter,
		TokenIn:      tokenIn,
		TokenOut:     tokenOut,
		UniV3Fee:     pool.Fee,
		AeroStable:   false,
		AeroFactory:  common.Address{},
		MinAmountOut: minAmountOut,
	}
}
