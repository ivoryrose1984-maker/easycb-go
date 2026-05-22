package logger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

// Client posts rows to Supabase via REST. Logs fire-and-forget so they never
// block the hot path. Missing env vars disable logging silently.
type Client struct {
	url    string
	key    string
	http   *http.Client
	active bool
}

var defaultClient *Client

func init() {
	url := os.Getenv("ARB_SUPABASE_URL")
	key := os.Getenv("ARB_SUPABASE_KEY")
	defaultClient = &Client{
		url:    url,
		key:    key,
		http:   &http.Client{Timeout: 5 * time.Second},
		active: url != "" && key != "",
	}
	if defaultClient.active {
		fmt.Println("[SUPABASE] ✅ Go bot logging enabled")
	}
}

type OpportunityRow struct {
	Bot                 string  `json:"bot"`
	BlockNumber         uint64  `json:"block_number"`
	TokenIn             string  `json:"token_in"`
	TokenOut            string  `json:"token_out"`
	TokenMid            string  `json:"token_mid,omitempty"`
	DexBuy              string  `json:"dex_buy,omitempty"`
	DexSell             string  `json:"dex_sell,omitempty"`
	AmountInUSDC        float64 `json:"amount_in_usdc"`
	ExpectedProfitUSDC  float64 `json:"expected_profit_usdc"`
	ScoreBps            int64   `json:"score_bps"`
	GasCostWei          string  `json:"gas_cost_wei"`
	Status              string  `json:"status"`
	ErrorMessage        string  `json:"error_message,omitempty"`
}

type TradeRow struct {
	Bot               string  `json:"bot"`
	BlockNumber       uint64  `json:"block_number"`
	TxHash            string  `json:"tx_hash"`
	TokenIn           string  `json:"token_in"`
	TokenOut          string  `json:"token_out"`
	TokenMid          string  `json:"token_mid,omitempty"`
	AmountInUSDC      float64 `json:"amount_in_usdc"`
	ActualProfitUSDC  float64 `json:"actual_profit_usdc"`
	GasCostWei        string  `json:"gas_cost_wei"`
	GasPriceGwei      float64 `json:"gas_price_gwei"`
	ExecutionTimeMs   int64   `json:"execution_time_ms"`
	Status            string  `json:"status"`
}

func LogOpportunity(row OpportunityRow) {
	row.Bot = "go"
	go defaultClient.insert("opportunities", row)
}

func LogTrade(row TradeRow) {
	row.Bot = "go"
	go defaultClient.insert("trades", row)
}

func (c *Client) insert(table string, row any) {
	if !c.active {
		return
	}
	body, err := json.Marshal(row)
	if err != nil {
		return
	}
	req, err := http.NewRequest("POST",
		fmt.Sprintf("%s/rest/v1/%s", c.url, table),
		bytes.NewReader(body),
	)
	if err != nil {
		return
	}
	req.Header.Set("apikey", c.key)
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "return=minimal")

	resp, err := c.http.Do(req)
	if err != nil {
		fmt.Printf("[SUPABASE] insert %s error: %v\n", table, err)
		return
	}
	resp.Body.Close()
}
