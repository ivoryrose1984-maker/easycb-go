// filepath: internal/flashloan/flash.go
package flashloan

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	arbtypes "github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
	"go.uber.org/zap"
)

// flashLoanABI matches executeArbitrage(address,uint256,(address,address,address,uint24,bool,address,uint256)[])
const flashLoanABI = `[{
  "inputs":[
    {"name":"flashToken","type":"address"},
    {"name":"flashAmount","type":"uint256"},
    {"components":[
      {"name":"dexRouter","type":"address"},
      {"name":"tokenIn","type":"address"},
      {"name":"tokenOut","type":"address"},
      {"name":"uniV3Fee","type":"uint24"},
      {"name":"aeroStable","type":"bool"},
      {"name":"aeroFactory","type":"address"},
      {"name":"minAmountOut","type":"uint256"}
    ],"name":"steps","type":"tuple[]"}
  ],
  "name":"executeArbitrage","outputs":[],"stateMutability":"nonpayable","type":"function"
}]`

// Executor sends flash loan transactions to the deployed FlashLoan.sol contract.
type Executor struct {
	client       *ethclient.Client
	contractAddr common.Address
	contractABI  abi.ABI
	privateKey   *ecdsa.PrivateKey
	gasLimit     uint64
	chainID      *big.Int
	logger       *zap.Logger
}

// NewExecutor creates an Executor.
func NewExecutor(
	client *ethclient.Client,
	contractAddr common.Address,
	privateKeyHex string,
	gasLimit uint64,
	chainID *big.Int,
	logger *zap.Logger,
) (*Executor, error) {
	pk, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}
	parsedABI, err := abi.JSON(strings.NewReader(flashLoanABI))
	if err != nil {
		return nil, fmt.Errorf("parse ABI: %w", err)
	}
	return &Executor{
		client:       client,
		contractAddr: contractAddr,
		contractABI:  parsedABI,
		privateKey:   pk,
		gasLimit:     gasLimit,
		chainID:      chainID,
		logger:       logger,
	}, nil
}

// abiSwapStep mirrors the Solidity tuple for ABI encoding.
type abiSwapStep struct {
	DexRouter    common.Address
	TokenIn      common.Address
	TokenOut     common.Address
	UniV3Fee     *big.Int // uint24
	AeroStable   bool
	AeroFactory  common.Address
	MinAmountOut *big.Int
}

// Simulate performs a dry eth_call of executeArbitrage to detect reverts before broadcast.
// Returns nil if the call succeeds; a descriptive error if it would revert.
func (e *Executor) Simulate(ctx context.Context, cycle *arbtypes.Cycle) error {
	if len(cycle.Steps) != 3 {
		return fmt.Errorf("cycle must have exactly 3 steps")
	}

	steps := make([]abiSwapStep, 3)
	for i, s := range cycle.Steps {
		steps[i] = abiSwapStep{
			DexRouter:    s.DexRouter,
			TokenIn:      s.TokenIn,
			TokenOut:     s.TokenOut,
			UniV3Fee:     new(big.Int).SetUint64(uint64(s.UniV3Fee)),
			AeroStable:   s.AeroStable,
			AeroFactory:  s.AeroFactory,
			MinAmountOut: s.MinAmountOut,
		}
	}

	data, err := e.contractABI.Pack("executeArbitrage",
		cycle.Tokens[0].Address,
		cycle.AmountIn,
		steps,
	)
	if err != nil {
		return fmt.Errorf("pack executeArbitrage: %w", err)
	}

	pub := e.privateKey.Public().(*ecdsa.PublicKey)
	from := crypto.PubkeyToAddress(*pub)

	_, err = e.client.CallContract(ctx, ethereum.CallMsg{
		From: from,
		To:   &e.contractAddr,
		Data: data,
	}, nil) // nil = latest block
	if err != nil {
		return fmt.Errorf("preflight simulation reverted: %w", err)
	}
	return nil
}

// Execute builds and broadcasts the flash loan transaction.
// Returns the transaction hash on success.
func (e *Executor) Execute(ctx context.Context, cycle *arbtypes.Cycle) (string, error) {
	if len(cycle.Steps) != 3 {
		return "", fmt.Errorf("cycle must have exactly 3 steps")
	}

	steps := make([]abiSwapStep, 3)
	for i, s := range cycle.Steps {
		steps[i] = abiSwapStep{
			DexRouter:    s.DexRouter,
			TokenIn:      s.TokenIn,
			TokenOut:     s.TokenOut,
			UniV3Fee:     new(big.Int).SetUint64(uint64(s.UniV3Fee)),
			AeroStable:   s.AeroStable,
			AeroFactory:  s.AeroFactory,
			MinAmountOut: s.MinAmountOut,
		}
	}

	data, err := e.contractABI.Pack("executeArbitrage",
		cycle.Tokens[0].Address, // flashToken (always start token)
		cycle.AmountIn,
		steps,
	)
	if err != nil {
		return "", fmt.Errorf("pack executeArbitrage: %w", err)
	}

	auth, err := e.buildTransactOpts(ctx)
	if err != nil {
		return "", err
	}

	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   e.chainID,
		Nonce:     auth.Nonce.Uint64(),
		GasTipCap: auth.GasTipCap,
		GasFeeCap: auth.GasFeeCap,
		Gas:       e.gasLimit,
		To:        &e.contractAddr,
		Data:      data,
	})

	signedTx, err := types.SignTx(tx, types.NewLondonSigner(e.chainID), e.privateKey)
	if err != nil {
		return "", fmt.Errorf("sign tx: %w", err)
	}

	if err := e.client.SendTransaction(ctx, signedTx); err != nil {
		return "", fmt.Errorf("send tx: %w", err)
	}

	e.logger.Info("transaction sent",
		zap.String("hash", signedTx.Hash().Hex()),
		zap.String("to", e.contractAddr.Hex()),
	)
	return signedTx.Hash().Hex(), nil
}

func (e *Executor) buildTransactOpts(ctx context.Context) (*bind.TransactOpts, error) {
	pub := e.privateKey.Public().(*ecdsa.PublicKey)
	addr := crypto.PubkeyToAddress(*pub)

	nonce, err := e.client.PendingNonceAt(ctx, addr)
	if err != nil {
		return nil, fmt.Errorf("pending nonce: %w", err)
	}

	// EIP-1559 pricing
	head, err := e.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("latest header: %w", err)
	}
	baseFee := head.BaseFee
	tip := big.NewInt(1_000_000) // 0.001 gwei tip on Base is sufficient
	feeCap := new(big.Int).Add(
		new(big.Int).Mul(baseFee, big.NewInt(2)),
		tip,
	)

	return &bind.TransactOpts{
		Nonce:     new(big.Int).SetUint64(nonce),
		GasTipCap: tip,
		GasFeeCap: feeCap,
	}, nil
}
