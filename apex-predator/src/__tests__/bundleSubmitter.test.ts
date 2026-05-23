// src/__tests__/bundleSubmitter.test.ts
import { submitRawTransactionsToBase, RawTxSubmitResult } from '../core/bundleSubmitter';

const VALID_TX  = '0x' + 'aa'.repeat(50);
const TX_HASH   = '0x' + 'bb'.repeat(32);
const ENDPOINTS = [
  'https://rpc.flashbots.net',
  'https://rpc.titanbuilder.xyz',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
];

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function okFetch(txHash = TX_HASH): jest.Mock {
  return jest.fn().mockResolvedValue({
    status: 200,
    json:   () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: txHash }),
  });
}

function rpcErrorFetch(message: string): jest.Mock {
  return jest.fn().mockResolvedValue({
    status: 200,
    json:   () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }),
  });
}

// ── Method guards (the core requirement for Base) ─────────────────────────────

test('uses eth_sendRawTransaction — never eth_sendBundle', async () => {
  const mockFetch = okFetch();
  await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  const methods: string[] = mockFetch.mock.calls.map((c: any[]) => JSON.parse(c[1].body).method);
  expect(methods.every(m => m === 'eth_sendRawTransaction')).toBe(true);
  expect(methods).not.toContain('eth_sendBundle');
  expect(methods).not.toContain('mev_sendBundle');
});

test('sends the exact signed tx hex as the sole RPC param', async () => {
  const mockFetch = okFetch();
  await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: [ENDPOINTS[0]],
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.params).toEqual([VALID_TX]);
});

// ── All four Base endpoints ───────────────────────────────────────────────────

test('attempts all four configured Base endpoints', async () => {
  const mockFetch = okFetch();
  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  const attempted = results.map(r => r.endpoint);
  for (const ep of ENDPOINTS) {
    expect(attempted).toContain(ep);
  }
  expect(mockFetch).toHaveBeenCalledTimes(ENDPOINTS.length);
});

// ── Partial failure ───────────────────────────────────────────────────────────

test('failed endpoint does not prevent success at other endpoints', async () => {
  const mockFetch = jest.fn().mockImplementation((url: string) => {
    if (url === ENDPOINTS[0]) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ error: { code: -32000, message: 'nonce too low' } }),
      });
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ result: TX_HASH }) });
  });

  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  });

  const successes = results.filter(r => r.success);
  const failures  = results.filter(r => !r.success);
  expect(successes.length).toBeGreaterThan(0);
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0].endpoint).toBe(ENDPOINTS[0]);
});

// ── Deduplication ─────────────────────────────────────────────────────────────

test('submits duplicate signed txs only once per endpoint', async () => {
  const mockFetch = okFetch();
  await submitRawTransactionsToBase({
    signedTxs: [VALID_TX, VALID_TX, VALID_TX], endpoints: [ENDPOINTS[0]],
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  // 1 unique tx × 1 endpoint = 1 call
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('preserves first-seen order when deduplicating', async () => {
  const TX_A = '0x' + 'aa'.repeat(50);
  const TX_B = '0x' + 'bb'.repeat(50);
  const mockFetch = okFetch();
  await submitRawTransactionsToBase({
    signedTxs: [TX_A, TX_B, TX_A], endpoints: [ENDPOINTS[0]],
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  // Should call twice (TX_A, TX_B) not three times
  expect(mockFetch).toHaveBeenCalledTimes(2);
  const firstParam  = JSON.parse(mockFetch.mock.calls[0][1].body).params[0];
  const secondParam = JSON.parse(mockFetch.mock.calls[1][1].body).params[0];
  expect(firstParam).toBe(TX_A);
  expect(secondParam).toBe(TX_B);
});

// ── Input validation (zero network calls) ─────────────────────────────────────

test('throws before any network call when signedTxs is empty', async () => {
  const mockFetch = jest.fn();
  await expect(submitRawTransactionsToBase({
    signedTxs: [], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  })).rejects.toThrow('non-empty array');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('throws before any network call when a tx lacks 0x prefix', async () => {
  const mockFetch = jest.fn();
  await expect(submitRawTransactionsToBase({
    signedTxs: ['deadbeef1234'], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  })).rejects.toThrow('Invalid signed raw transaction hex');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('throws before any network call when endpoints is empty', async () => {
  const mockFetch = jest.fn();
  await expect(submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: [],
    fetchImpl: mockFetch as any, logger: silentLogger,
  })).rejects.toThrow('non-empty array');
  expect(mockFetch).not.toHaveBeenCalled();
});

// ── Timeout ───────────────────────────────────────────────────────────────────

test('timeout returns structured failure with "timeout after Xms" message', async () => {
  const TIMEOUT_MS = 50;
  const mockFetch = jest.fn().mockImplementation((_url: string, opts: any) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })
  );

  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: [ENDPOINTS[0]],
    timeoutMs: TIMEOUT_MS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  });

  expect(results[0].success).toBe(false);
  expect(results[0].error).toBe(`timeout after ${TIMEOUT_MS}ms`);
});

// ── Non-JSON response ─────────────────────────────────────────────────────────

test('handles non-JSON response without throwing', async () => {
  const mockFetch = jest.fn().mockResolvedValue({
    status: 502,
    json:   () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
  });

  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: [ENDPOINTS[0]],
    fetchImpl: mockFetch as any, logger: silentLogger,
  });

  expect(results[0].success).toBe(false);
  expect(results[0].error).toContain('Non-JSON RPC response');
  expect(results[0].error).toContain('502');
});

// ── Result structure ──────────────────────────────────────────────────────────

test('every result includes endpoint and txIndex fields', async () => {
  const mockFetch = okFetch();
  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: ENDPOINTS,
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  for (const r of results) {
    expect(typeof r.endpoint).toBe('string');
    expect(typeof r.txIndex).toBe('number');
    expect(typeof r.success).toBe('boolean');
  }
});

test('successful result includes the txHash returned by the endpoint', async () => {
  const mockFetch = okFetch(TX_HASH);
  const results = await submitRawTransactionsToBase({
    signedTxs: [VALID_TX], endpoints: [ENDPOINTS[0]],
    fetchImpl: mockFetch as any, logger: silentLogger,
  });
  const success = results.find(r => r.success);
  expect(success?.txHash).toBe(TX_HASH);
});
