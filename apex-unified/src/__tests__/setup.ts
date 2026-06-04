// Set required env vars before any module (including config.ts) is imported.
// These are test-only placeholders — no real RPC connection is made in unit tests.
process.env.ALCHEMY_WSS_URL = 'wss://test-placeholder';
process.env.DRY_RUN         = 'true';
process.env.ALLOW_LIVE      = 'false';
