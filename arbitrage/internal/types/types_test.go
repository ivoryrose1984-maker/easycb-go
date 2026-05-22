package types

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestCycle_Profitable(t *testing.T) {
	zero := new(big.Int)
	pos  := big.NewInt(1_000_000)
	neg  := big.NewInt(-1)

	cases := []struct {
		name string
		pnl  *big.Int
		want bool
	}{
		{"nil pnl", nil, false},
		{"zero pnl", zero, false},
		{"negative pnl", neg, false},
		{"positive pnl", pos, true},
	}

	for _, tc := range cases {
		c := &Cycle{NetPnLUSDC: tc.pnl}
		if got := c.Profitable(); got != tc.want {
			t.Errorf("%s: Profitable() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCycle_Fields(t *testing.T) {
	usdc := common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
	weth := common.HexToAddress("0x4200000000000000000000000000000000000006")
	usdt := common.HexToAddress("0xfde4C96c8593536E31F0E8c0FFF4E4b5770B80EC")

	cycle := &Cycle{
		Tokens:     [3]Token{{Address: usdc, Symbol: "USDC"}, {Address: weth, Symbol: "WETH"}, {Address: usdt, Symbol: "USDT"}},
		AmountIn:   new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000)),
		AmountOut:  new(big.Int).Mul(big.NewInt(10_050), big.NewInt(1_000_000)),
		GrossPnL:   new(big.Int).Mul(big.NewInt(50), big.NewInt(1_000_000)),
		GasCostEst: big.NewInt(50_000),
		NetPnLUSDC: new(big.Int).Sub(
			new(big.Int).Mul(big.NewInt(50), big.NewInt(1_000_000)),
			big.NewInt(50_000),
		),
	}

	if !cycle.Profitable() {
		t.Error("cycle with positive NetPnLUSDC should be Profitable")
	}

	// GrossPnL = AmountOut - AmountIn
	gross := new(big.Int).Sub(cycle.AmountOut, cycle.AmountIn)
	if gross.Cmp(cycle.GrossPnL) != 0 {
		t.Errorf("GrossPnL mismatch: got %v, want %v", cycle.GrossPnL, gross)
	}

	// NetPnLUSDC = GrossPnL - GasCostEst
	net := new(big.Int).Sub(cycle.GrossPnL, cycle.GasCostEst)
	if net.Cmp(cycle.NetPnLUSDC) != 0 {
		t.Errorf("NetPnLUSDC mismatch: got %v, want %v", cycle.NetPnLUSDC, net)
	}
}

func TestSwapStep_ZeroFeeIsAerodrome(t *testing.T) {
	// UniV3Fee == 0 signals Aerodrome; > 0 signals Uniswap V3
	aeroStep := SwapStep{UniV3Fee: 0, AeroStable: false}
	uniStep  := SwapStep{UniV3Fee: 3000}

	if aeroStep.UniV3Fee != 0 {
		t.Error("Aerodrome step must have UniV3Fee == 0")
	}
	if uniStep.UniV3Fee == 0 {
		t.Error("Uniswap V3 step must have UniV3Fee > 0")
	}
}
