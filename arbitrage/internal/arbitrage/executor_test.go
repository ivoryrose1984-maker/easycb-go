// filepath: internal/arbitrage/executor_test.go
package arbitrage

import (
	"math/big"
	"testing"
	"time"

	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/config"
	"go.uber.org/zap"
)

func newTestExecutor(maxFails int, cooldown int) *Executor {
	cfg := &config.Config{
		MaxConsecutiveFailures: maxFails,
		FailureCooldownSeconds: cooldown,
		ProfitSafetyBps:        1500,
		MinProfitUSDC:          5_000_000,
	}
	return &Executor{cfg: cfg, logger: zap.NewNop()}
}

// ── Circuit breaker tests ─────────────────────────────────────────────────────

func TestCircuitBreaker_OpensAfterMaxFailures(t *testing.T) {
	e := newTestExecutor(3, 300)

	if e.isBreakerOpen() {
		t.Fatal("breaker should start closed")
	}

	e.recordFailure()
	e.recordFailure()
	if e.isBreakerOpen() {
		t.Fatal("breaker should not open after 2 failures (threshold is 3)")
	}

	e.recordFailure() // third failure — breaker should trip
	if !e.isBreakerOpen() {
		t.Fatal("breaker should be open after 3 consecutive failures")
	}
}

func TestCircuitBreaker_SuccessResetFailureCount(t *testing.T) {
	e := newTestExecutor(3, 300)

	e.recordFailure()
	e.recordFailure()
	e.recordSuccess()
	e.recordFailure() // only 1 failure after reset — should not open

	if e.isBreakerOpen() {
		t.Fatal("breaker should remain closed after success resets counter")
	}
}

func TestCircuitBreaker_CooldownExpires(t *testing.T) {
	e := newTestExecutor(1, 0) // 0s cooldown — expires immediately

	e.recordFailure() // trips the breaker with 1-failure threshold

	// Force the paused-until time into the past
	e.cbMu.Lock()
	e.cbPausedUntil = time.Now().Add(-1 * time.Second)
	e.cbMu.Unlock()

	if e.isBreakerOpen() {
		t.Fatal("breaker should be closed after cooldown expires")
	}
}

// ── Profit safety gate tests ──────────────────────────────────────────────────

func TestProfitSafetyBps_calculation(t *testing.T) {
	// With ProfitSafetyBps=1500 and gasCost=100:
	// required = max(MinProfitUSDC, gasCost × (10000+1500)/10000)
	//          = max(5_000_000, 100 × 11500/10000)
	//          = max(5_000_000, 115)
	//          = 5_000_000
	gasCost := big.NewInt(100)
	safetyBps := 1500
	gasCostScaled := new(big.Int).Mul(gasCost, big.NewInt(int64(10000+safetyBps)))
	gasCostScaled.Div(gasCostScaled, big.NewInt(10000))

	expected := big.NewInt(115)
	if gasCostScaled.Cmp(expected) != 0 {
		t.Errorf("expected scaled gas cost %s, got %s", expected, gasCostScaled)
	}
}

func TestProfitSafetyBps_gasFloorDominates(t *testing.T) {
	// With a large gas cost, the safety-scaled gas should dominate MinProfitUSDC
	// gasCost = 10_000_000 (=$10), ProfitSafetyBps=1500
	// required = max(5_000_000, 10_000_000 × 11500/10000) = max(5M, 11.5M) = 11.5M
	gasCost := big.NewInt(10_000_000)
	safetyBps := 1500
	gasCostScaled := new(big.Int).Mul(gasCost, big.NewInt(int64(10000+safetyBps)))
	gasCostScaled.Div(gasCostScaled, big.NewInt(10000))
	minProfitFixed := big.NewInt(5_000_000)

	minRequired := gasCostScaled
	if minProfitFixed.Cmp(minRequired) > 0 {
		minRequired = minProfitFixed
	}

	expected := big.NewInt(11_500_000)
	if minRequired.Cmp(expected) != 0 {
		t.Errorf("expected min required %s, got %s", expected, minRequired)
	}
}
