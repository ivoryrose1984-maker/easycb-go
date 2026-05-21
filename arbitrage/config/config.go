// filepath: config/config.go
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all runtime configuration.
type Config struct {
	// RPC — rotate through these to reduce rate-limit fingerprint
	RPCURLs []string `mapstructure:"rpc_urls"`

	// Wallet
	PrivateKey string `mapstructure:"private_key"`

	// Contract address of the deployed FlashLoan.sol on Base
	FlashLoanContract string `mapstructure:"flash_loan_contract"`

	// Minimum net profit in USDC micro-units (6 dec) to execute a cycle
	MinProfitUSDC int64 `mapstructure:"min_profit_usdc"` // e.g. 5_000_000 = $5

	// Gas
	GasLimitArb   uint64  `mapstructure:"gas_limit_arb"`    // e.g. 600_000
	MaxGasGwei    float64 `mapstructure:"max_gas_gwei"`     // abort if base fee above this

	// Timing
	ScanInterval    time.Duration `mapstructure:"scan_interval"`     // e.g. 500ms
	RPCRotateEvery  int           `mapstructure:"rpc_rotate_every"`  // rotate RPC every N scans
	MaxJitterMS     int           `mapstructure:"max_jitter_ms"`     // random delay upper bound

	// Dry run — log opportunities but do not send transactions
	DryRun bool `mapstructure:"dry_run"`

	// Log level: debug | info | warn | error
	LogLevel string `mapstructure:"log_level"`
}

// Load reads config from env vars and optionally a YAML file.
// Env vars are prefixed with ARB_ (e.g. ARB_PRIVATE_KEY).
func Load() (*Config, error) {
	v := viper.New()

	// Defaults
	v.SetDefault("rpc_urls", []string{"https://mainnet.base.org"})
	v.SetDefault("min_profit_usdc", 5_000_000)  // $5
	v.SetDefault("gas_limit_arb", 600_000)
	v.SetDefault("max_gas_gwei", 5.0)
	v.SetDefault("scan_interval", "500ms")
	v.SetDefault("rpc_rotate_every", 20)
	v.SetDefault("max_jitter_ms", 200)
	v.SetDefault("dry_run", true)
	v.SetDefault("log_level", "info")

	// File (optional)
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	_ = v.ReadInConfig() // ok if missing

	// Env overrides
	v.SetEnvPrefix("ARB")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}

	if cfg.PrivateKey == "" {
		return nil, fmt.Errorf("ARB_PRIVATE_KEY is required")
	}
	if len(cfg.RPCURLs) == 0 {
		return nil, fmt.Errorf("ARB_RPC_URLS is required")
	}
	return &cfg, nil
}
