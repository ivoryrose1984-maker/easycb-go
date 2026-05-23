// filepath: internal/arbitrage/triangle_test.go
package arbitrage

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
)

func TestDirectionalCycleKey_Directional(t *testing.T) {
	base := common.HexToAddress("0xAAAA")
	mid  := common.HexToAddress("0xBBBB")
	end  := common.HexToAddress("0xCCCC")
	pool := types.Pool{
		Address: common.HexToAddress("0x1111"),
		Type:    types.PoolTypeUniswapV3,
	}

	// base→mid→end and base→end→mid must produce different keys
	k1 := directionalCycleKey(base, mid, end, pool, pool, pool)
	k2 := directionalCycleKey(base, end, mid, pool, pool, pool)
	if k1 == k2 {
		t.Errorf("directionalCycleKey: different directions produced the same key")
	}
}

func TestDirectionalCycleKey_PoolSpecific(t *testing.T) {
	base := common.HexToAddress("0xAAAA")
	mid  := common.HexToAddress("0xBBBB")
	end  := common.HexToAddress("0xCCCC")

	p1 := types.Pool{Address: common.HexToAddress("0x1111"), Type: types.PoolTypeUniswapV3}
	p2 := types.Pool{Address: common.HexToAddress("0x2222"), Type: types.PoolTypeUniswapV3}

	// same token path, different pool addresses → different keys
	k1 := directionalCycleKey(base, mid, end, p1, p1, p1)
	k2 := directionalCycleKey(base, mid, end, p2, p1, p1)
	if k1 == k2 {
		t.Errorf("directionalCycleKey: different pool addresses produced the same key")
	}
}

func TestDirectionalCycleKey_PoolTypeSpecific(t *testing.T) {
	base := common.HexToAddress("0xAAAA")
	mid  := common.HexToAddress("0xBBBB")
	end  := common.HexToAddress("0xCCCC")
	addr := common.HexToAddress("0x1111")

	pUni  := types.Pool{Address: addr, Type: types.PoolTypeUniswapV3}
	pAero := types.Pool{Address: addr, Type: types.PoolTypeAerodromeVol}

	// same address, different pool type → different keys
	k1 := directionalCycleKey(base, mid, end, pUni, pUni, pUni)
	k2 := directionalCycleKey(base, mid, end, pAero, pUni, pUni)
	if k1 == k2 {
		t.Errorf("directionalCycleKey: different pool types produced the same key")
	}
}

func TestDirectionalCycleKey_Idempotent(t *testing.T) {
	base := common.HexToAddress("0xAAAA")
	mid  := common.HexToAddress("0xBBBB")
	end  := common.HexToAddress("0xCCCC")
	pool := types.Pool{Address: common.HexToAddress("0x1111"), Type: types.PoolTypeUniswapV3}

	k1 := directionalCycleKey(base, mid, end, pool, pool, pool)
	k2 := directionalCycleKey(base, mid, end, pool, pool, pool)
	if k1 != k2 {
		t.Errorf("directionalCycleKey: same inputs produced different keys")
	}
}
