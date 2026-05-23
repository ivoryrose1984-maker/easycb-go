// filepath: internal/dex/aerodrome.go
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
	AeroFactoryAddr = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da"
	AeroRouterAddr  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"
)

const aeroFactoryABI = `[{
  "inputs":[{"type":"address"},{"type":"address"},{"type":"bool"}],
  "name":"getPool","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"
}]`

const aeroRouterABI = `[{
  "inputs":[{"type":"uint256"},{"components":[
    {"name":"from","type":"address"},{"name":"to","type":"address"},
    {"name":"stable","type":"bool"},{"name":"factory","type":"address"}
  ],"name":"routes","type":"tuple[]"}],
  "name":"getAmountsOut",
  "outputs":[{"type":"uint256[]"}],"stateMutability":"view","type":"function"
}]`

// Aerodrome is the Aerodrome V1 DEX adapter (Base mainnet).
type Aerodrome struct {
	client      *ethclient.Client
	factoryABI  abi.ABI
	routerABI   abi.ABI
	factoryAddr common.Address
	routerAddr  common.Address
}

// NewAerodrome constructs the adapter.
func NewAerodrome(client *ethclient.Client) (*Aerodrome, error) {
	fABI, err := abi.JSON(strings.NewReader(aeroFactoryABI))
	if err != nil {
		return nil, err
	}
	rABI, err := abi.JSON(strings.NewReader(aeroRouterABI))
	if err != nil {
		return nil, err
	}
	return &Aerodrome{
		client:      client,
		factoryABI:  fABI,
		routerABI:   rABI,
		factoryAddr: common.HexToAddress(AeroFactoryAddr),
		routerAddr:  common.HexToAddress(AeroRouterAddr),
	}, nil
}

func (a *Aerodrome) Name() string { return "aerodrome" }

// GetPools returns both stable and volatile Aerodrome pools for a pair.
func (a *Aerodrome) GetPools(ctx context.Context, tokenA, tokenB common.Address) ([]types.Pool, error) {
	var pools []types.Pool
	for _, stable := range []bool{false, true} {
		data, err := a.factoryABI.Pack("getPool", tokenA, tokenB, stable)
		if err != nil {
			continue
		}
		result, err := a.client.CallContract(ctx, ethereum.CallMsg{
			To: &a.factoryAddr, Data: data,
		}, nil)
		if err != nil || len(result) < 32 {
			continue
		}
		poolAddr := common.BytesToAddress(result[12:32])
		if poolAddr == (common.Address{}) {
			continue
		}
		pt := types.PoolTypeAerodromeVol
		if stable {
			pt = types.PoolTypeAerodromeStb
		}
		pools = append(pools, types.Pool{
			Address:    poolAddr,
			Token0:     types.Token{Address: tokenA},
			Token1:     types.Token{Address: tokenB},
			Type:       pt,
			Fee:        0,
			DEXRouter:  a.routerAddr,
			DEXFactory: a.factoryAddr,
		})
	}
	return pools, nil
}

// GetQuote calls getAmountsOut on the Aerodrome router.
func (a *Aerodrome) GetQuote(ctx context.Context, pool types.Pool, tokenIn common.Address, amountIn *big.Int) (*big.Int, error) {
	tokenOut := pool.Token0.Address
	if tokenIn == pool.Token0.Address {
		tokenOut = pool.Token1.Address
	}
	stable := pool.Type == types.PoolTypeAerodromeStb

	type Route struct {
		From    common.Address
		To      common.Address
		Stable  bool
		Factory common.Address
	}
	routes := []Route{{From: tokenIn, To: tokenOut, Stable: stable, Factory: a.factoryAddr}}

	data, err := a.routerABI.Pack("getAmountsOut", amountIn, routes)
	if err != nil {
		return nil, fmt.Errorf("pack getAmountsOut: %w", err)
	}
	result, err := a.client.CallContract(ctx, ethereum.CallMsg{
		To: &a.routerAddr, Data: data,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("getAmountsOut call: %w", err)
	}
	out, err := a.routerABI.Unpack("getAmountsOut", result)
	if err != nil {
		return nil, fmt.Errorf("unpack getAmountsOut: %w", err)
	}
	amounts, ok := out[0].([]*big.Int)
	if !ok || len(amounts) < 2 {
		return nil, fmt.Errorf("getAmountsOut: unexpected result %v", out)
	}
	return new(big.Int).Set(amounts[len(amounts)-1]), nil
}

// BuildSwapStep returns the SwapStep struct for the flash loan contract.
func (a *Aerodrome) BuildSwapStep(pool types.Pool, tokenIn common.Address, amountIn, minAmountOut *big.Int) types.SwapStep {
	tokenOut := pool.Token0.Address
	if tokenIn == pool.Token0.Address {
		tokenOut = pool.Token1.Address
	}
	return types.SwapStep{
		DexRouter:    pool.DEXRouter,
		TokenIn:      tokenIn,
		TokenOut:     tokenOut,
		UniV3Fee:     0,
		AeroStable:   pool.Type == types.PoolTypeAerodromeStb,
		AeroFactory:  pool.DEXFactory,
		MinAmountOut: minAmountOut,
	}
}
