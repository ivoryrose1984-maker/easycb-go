// filepath: internal/flashloan/flash.go
package flashloan

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

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
	builderURLs  []string // private builder RPC endpoints
	httpClient   *http.Client
	logger       *zap.Logger
}

// NewExecutor creates an Executor.
func NewExecutor(
	client *ethclient.Client,
	contractAddr common.Address,
	privateKeyHex string,
	gasLimit uint64,
	chainID *big.Int,
	builderURLs []string,
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
		builderURLs:  builderURLs,
		httpClient:   &http.Client{Timeout: 5 * time.Second},
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

func buildSteps(cycle *arbtypes.Cycle) []abiSwapStep {
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
	return steps
}

func (e *Executor) packData(cycle *arbtypes.Cycle) ([]byte, error) {
	if len(cycle.Steps) != 3 {
		return nil, fmt.Errorf("cycle must have exactly 3 steps")
	}
	return e.contractABI.Pack("executeArbitrage",
		cycle.Tokens[0].Address,
		cycle.AmountIn,
		buildSteps(cycle),
	)
}

// Simulate performs a dry eth_call of executeArbitrage to detect reverts before broadcast.
func (e *Executor) Simulate(ctx context.Context, cycle *arbtypes.Cycle) error {
	data, err := e.packData(cycle)
	if err != nil {
		return fmt.Errorf("pack: %w", err)
	}
	pub := e.privateKey.Public().(*ecdsa.PublicKey)
	from := crypto.PubkeyToAddress(*pub)
	_, err = e.client.CallContract(ctx, ethereum.CallMsg{
		From: from,
		To:   &e.contractAddr,
		Data: data,
	}, nil)
	if err != nil {
		return fmt.Errorf("preflight simulation reverted: %w", err)
	}
	return nil
}

// Execute builds the signed transaction and sends it to private builders concurrently.
// Falls back to the public mempool if no builders are configured.
// Returns the transaction hash on success.
func (e *Executor) Execute(ctx context.Context, cycle *arbtypes.Cycle) (string, error) {
	data, err := e.packData(cycle)
	if err != nil {
		return "", err
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

	if len(e.builderURLs) > 0 {
		return e.sendToBuilders(ctx, signedTx)
	}

	// Public mempool fallback (dry-run or no builders configured)
	if err := e.client.SendTransaction(ctx, signedTx); err != nil {
		return "", fmt.Errorf("send tx: %w", err)
	}
	hash := signedTx.Hash().Hex()
	e.logger.Info("transaction sent via public mempool", zap.String("hash", hash))
	return hash, nil
}

// sendToBuilders submits the signed tx to all configured private builders concurrently
// via standard JSON-RPC eth_sendRawTransaction. Returns on the first success.
func (e *Executor) sendToBuilders(ctx context.Context, signedTx *types.Transaction) (string, error) {
	rawTx, err := signedTx.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("marshal tx: %w", err)
	}
	hexTx := "0x" + hex.EncodeToString(rawTx)

	body, _ := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "eth_sendRawTransaction",
		"params":  []string{hexTx},
		"id":      1,
	})

	type result struct {
		builder string
		hash    string
		err     error
	}
	results := make(chan result, len(e.builderURLs))

	var wg sync.WaitGroup
	for _, url := range e.builderURLs {
		wg.Add(1)
		go func(builderURL string) {
			defer wg.Done()
			start := time.Now()
			hash, err := e.postRawTx(ctx, builderURL, body)
			elapsed := time.Since(start)
			if err != nil {
				e.logger.Debug("builder rejected tx",
					zap.String("builder", builderURL),
					zap.Duration("elapsed", elapsed),
					zap.Error(err),
				)
			} else {
				e.logger.Info("builder accepted tx",
					zap.String("builder", builderURL),
					zap.String("hash", hash),
					zap.Duration("elapsed", elapsed),
				)
			}
			results <- result{builder: builderURL, hash: hash, err: err}
		}(url)
	}

	go func() { wg.Wait(); close(results) }()

	var errs []string
	for r := range results {
		if r.err == nil && r.hash != "" {
			// Drain remaining results without blocking
			go func() {
				for range results {
				}
			}()
			return r.hash, nil
		}
		if r.err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", r.builder, r.err.Error()))
		}
	}
	return "", fmt.Errorf("all builders failed: %s", strings.Join(errs, "; "))
}

type rpcResponse struct {
	Result string `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (e *Executor) postRawTx(ctx context.Context, builderURL string, body []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, builderURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	var rpc rpcResponse
	if err := json.Unmarshal(respBody, &rpc); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if rpc.Error != nil {
		return "", fmt.Errorf("rpc error %d: %s", rpc.Error.Code, rpc.Error.Message)
	}
	return rpc.Result, nil
}

func (e *Executor) buildTransactOpts(ctx context.Context) (*bind.TransactOpts, error) {
	pub := e.privateKey.Public().(*ecdsa.PublicKey)
	addr := crypto.PubkeyToAddress(*pub)

	nonce, err := e.client.PendingNonceAt(ctx, addr)
	if err != nil {
		return nil, fmt.Errorf("pending nonce: %w", err)
	}

	head, err := e.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("latest header: %w", err)
	}
	baseFee := head.BaseFee
	tip := big.NewInt(1_000_000) // 0.001 gwei tip — sufficient on Base
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
