package arbitrage

import (
	"time"

	"github.com/ivoryrose1984-maker/easycb-go/arbitrage/internal/types"
)

const (
	MaxQuoteAgeMs  = 2_000 // 2 seconds = 1 Base L2 block
	WarnQuoteAgeMs = 1_000 // warn if quote older than 1 second
)

// QuotedCycle wraps a cycle with the timestamp when quotes were fetched.
type QuotedCycle struct {
	Cycle    *types.Cycle
	QuotedAt time.Time
}

// IsFresh returns true if the cycle's quotes are still within MaxQuoteAgeMs.
func (q *QuotedCycle) IsFresh() bool {
	return time.Since(q.QuotedAt) < time.Duration(MaxQuoteAgeMs)*time.Millisecond
}

// AgeMs returns how old the quote is in milliseconds.
func (q *QuotedCycle) AgeMs() int64 {
	return time.Since(q.QuotedAt).Milliseconds()
}

// IsWarnAge returns true if quote age is in the warning zone (1-2 seconds).
func (q *QuotedCycle) IsWarnAge() bool {
	age := time.Since(q.QuotedAt)
	return age >= time.Duration(WarnQuoteAgeMs)*time.Millisecond && q.IsFresh()
}
