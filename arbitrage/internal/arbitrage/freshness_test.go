package arbitrage

import (
	"testing"
	"time"

	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
)

func TestQuotedCycle_IsFresh(t *testing.T) {
	// Fresh quote
	q := &QuotedCycle{Cycle: &types.Cycle{}, QuotedAt: time.Now()}
	if !q.IsFresh() {
		t.Error("new quote should be fresh")
	}

	// Stale quote
	q2 := &QuotedCycle{Cycle: &types.Cycle{}, QuotedAt: time.Now().Add(-3 * time.Second)}
	if q2.IsFresh() {
		t.Error("3-second-old quote should be stale")
	}
}

func TestQuotedCycle_AgeMs(t *testing.T) {
	q := &QuotedCycle{Cycle: &types.Cycle{}, QuotedAt: time.Now().Add(-500 * time.Millisecond)}
	age := q.AgeMs()
	if age < 400 || age > 600 {
		t.Errorf("age should be ~500ms, got %d", age)
	}
}
