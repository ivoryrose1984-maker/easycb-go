package logger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

var (
	tgToken    string
	tgChatID   string
	tgActive   bool
	tgClient   = &http.Client{Timeout: 5 * time.Second}

	// Per-category rate limits so an error alert is never blocked by a profit message.
	tgProfitLast  atomic.Int64 // unix ms
	tgErrorLast   atomic.Int64
	tgStartupLast atomic.Int64
)

func init() {
	tgToken  = os.Getenv("ARB_TELEGRAM_BOT_TOKEN")
	tgChatID = os.Getenv("ARB_TELEGRAM_CHAT_ID")
	tgActive = tgToken != "" && tgChatID != ""
	if tgActive {
		fmt.Println("[TELEGRAM] ✅ Go bot alerts enabled")
	}
}

func TelegramProfit(profitUsd float64, txHash string) {
	if profitUsd < 5 {
		return
	}
	msg := fmt.Sprintf("💰 *PROFIT*\n\n$%.2f on Base\nTx: `%s`", profitUsd, txHash)
	sendTelegram(msg, &tgProfitLast)
}

func TelegramError(err string) {
	sendTelegram(fmt.Sprintf("⚠️ *Go Bot Error*\n\n%s", err), &tgErrorLast)
}

func TelegramStartup() {
	sendTelegram("✅ *Go bot started* — scanning Base L2", &tgStartupLast)
}

func sendTelegram(text string, lastSent *atomic.Int64) {
	if !tgActive {
		return
	}
	now := time.Now().UnixMilli()
	if now-lastSent.Load() < 60_000 {
		return // per-category rate limit: one alert per 60s
	}
	lastSent.Store(now)

	go func() {
		body, _ := json.Marshal(map[string]any{
			"chat_id":    tgChatID,
			"text":       text,
			"parse_mode": "Markdown",
		})
		url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", tgToken)
		resp, err := tgClient.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			fmt.Printf("[TELEGRAM] Send error: %v\n", err)
			return
		}
		resp.Body.Close()
	}()
}
