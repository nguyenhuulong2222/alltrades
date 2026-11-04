import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };
const { DEFAULT_RPCS, backoffMs, isTransient, rpcRequest, rpcUrls, viewFunction } = await import('./rpc.mjs');
const { runLoop } = await import('./worker.mjs');

const ok = (result) => ({ status: 200, json: async () => ({ jsonrpc: '2.0', result }) });
const http = (status) => ({ status, json: async () => ({}) });
const noWait = async () => {};
/** fetch stub: replies[i] is a Response-like, an Error to throw, or a function(url). Records URLs. */
function stub(replies) {
  const urls = [];
  const f = async (url) => {
    urls.push(url);
    const r = replies[urls.length - 1];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(url) : r;
  };
  f.urls = urls;
  return f;
}

test('defaults: FastNEAR first, dRPC fallback, never the deprecated endpoint', () => {
  assert.deepEqual(DEFAULT_RPCS, ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://archival-rpc.testnet.fastnear.com']);
  assert.ok(!DEFAULT_RPCS.some((u) => u.includes('rpc.testnet.near.org')));
  assert.deepEqual(rpcUrls({ NEAR_RPC_URL: 'https://x.example' })[0], 'https://x.example');
  assert.deepEqual(rpcUrls({ NEAR_RPC_URL: DEFAULT_RPCS[1] }), [DEFAULT_RPCS[1], DEFAULT_RPCS[0], DEFAULT_RPCS[2]]);
});
test('HTTP 429 → backoff and switch to the next endpoint', async () => {
  const f = stub([http(429), ok({ a: 1 })]);
  const events = [];
  const r = await rpcRequest('query', {}, { fetchImpl: f, wait: noWait, onEvent: (e) => events.push(e.type) });
  assert.deepEqual(r, { a: 1 });
  assert.deepEqual(f.urls, [DEFAULT_RPCS[0], DEFAULT_RPCS[1]]);
  assert.deepEqual(events, ['retry', 'switch']);
});
test('JSON-RPC -429 inside a 200 body (the deprecation reply) is transient too', async () => {
  const deprecated = { status: 200, json: async () => ({ error: { code: -429, message: 'WARNING! THIS ENDPOINT IS DEPRECATED!' } }) };
  const f = stub([deprecated, ok(7)]);
  assert.equal(await rpcRequest('query', {}, { fetchImpl: f, wait: noWait }), 7);
});
test('5xx, timeout and network errors are retried on the next endpoint', async () => {
  for (const failure of [http(502), http(503), http(500), Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), new TypeError('fetch failed')]) {
    const f = stub([failure, ok('fine')]);
    assert.equal(await rpcRequest('query', {}, { fetchImpl: f, wait: noWait }), 'fine');
    assert.equal(f.urls.length, 2);
  }
});
test('a contract error is not retried', async () => {
  const f = stub([{ status: 200, json: async () => ({ result: { error: 'wasm execution failed: Smart contract panicked: Unknown v2 job' } }) }]);
  await assert.rejects(rpcRequest('query', {}, { fetchImpl: f, wait: noWait }), /Contract error/);
  assert.equal(f.urls.length, 1);
});
test('a persistent outage gives up after maxAttempts with a transient error, cycling endpoints', async () => {
  const f = stub(Array(6).fill(http(429)));
  const waits = [];
  await assert.rejects(rpcRequest('query', {}, { fetchImpl: f, wait: async (ms) => waits.push(ms), random: () => 1 }), (e) => e.transient === true && /RPC unavailable after 6 attempts/.test(e.message));
  assert.deepEqual(f.urls, [...DEFAULT_RPCS, ...DEFAULT_RPCS]);
  assert.equal(waits.length, 5);
  assert.ok(waits.every((w, i) => i === 0 || w >= waits[i - 1]), 'backoff grows');
});
test('backoff has jitter between half and the full step, capped', () => {
  assert.equal(backoffMs(0, { random: () => 0 }), 250);
  assert.equal(backoffMs(0, { random: () => 1 }), 500);
  assert.equal(backoffMs(20, { random: () => 1 }), 8000);
});
test('isTransient classifies errors', () => {
  assert.ok(isTransient(Object.assign(new Error('x'), { cause: 429 })));
  assert.ok(isTransient(Object.assign(new Error('x'), { cause: 503 })));
  assert.ok(isTransient(new Error('Exceeded 3 attempts for https://x')));
  assert.ok(!isTransient(new Error('Smart contract panicked: Job is not open')));
  assert.ok(!isTransient(new Error('Agent key mismatch')));
});
test('viewFunction decodes the result bytes', async () => {
  const f = stub([ok({ result: [...Buffer.from('{"paused":true}')] })]);
  assert.deepEqual(await viewFunction('c.testnet', 'get_autopilot', {}, { fetchImpl: f, wait: noWait }), { paused: true });
});

// ---------- runLoop resilience ----------

const loopCtx = (runOnceErrors) => {
  let n = 0;
  return {
    calls: () => n,
    ctx: {
      stopPath: '/nonexistent/STOP',
      chain: { getAutopilot: async () => { n++; const e = runOnceErrors[n - 1]; if (e) throw e; return { paused: true }; } },
      statePath: '/nonexistent/state.json', briefs: new Map(), packs: new Map(), generate: async () => '',
    },
  };
};
test('runLoop survives a few transient errors and resets the count after a good pass', async () => {
  const e429 = Object.assign(new Error('rate limited'), { cause: 429 });
  const { ctx, calls } = loopCtx([e429, e429, null, e429, e429, null]);
  const lines = [];
  let t = 0;
  const r = await runLoop(ctx, { intervalMs: 1, untilMs: 6, now: () => t, wait: async () => { t += 1; }, onPass: (x) => lines.push(x) });
  assert.equal(r.stopped, 'until reached');
  assert.ok(calls() >= 6);
  assert.deepEqual(lines.filter((l) => l.transient_error).map((l) => l.consecutive), [1, 2, 1, 2]);
});
test('runLoop exits after 5 consecutive transient errors so the monitor can act', async () => {
  const e503 = Object.assign(new Error('unavailable'), { cause: 503 });
  const { ctx } = loopCtx(Array(10).fill(e503));
  const r = await runLoop(ctx, { intervalMs: 1, wait: noWait, onPass: () => {} });
  assert.equal(r.stopped, '5 consecutive transient RPC errors');
});
test('runLoop stops at once on a non-transient error', async () => {
  const { ctx, calls } = loopCtx([new Error('Smart contract panicked: something unexpected')]);
  const lines = [];
  const r = await runLoop(ctx, { intervalMs: 1, wait: noWait, onPass: (x) => lines.push(x) });
  assert.equal(r.stopped, 'fatal error');
  assert.equal(calls(), 1);
  assert.match(lines[0].fatal, /something unexpected/);
});
