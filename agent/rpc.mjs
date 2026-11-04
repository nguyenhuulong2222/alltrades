// Testnet RPC endpoints with failover, backoff and jitter.
//
// rpc.testnet.near.org is deprecated: on 2026-11-04 it answered 429 "THIS ENDPOINT IS DEPRECATED"
// and crashed the first autopilot soak run. It is deliberately not in this list.
// Override the primary with NEAR_RPC_URL; the defaults stay behind it as fallbacks.

export const DEFAULT_RPCS = [
  'https://test.rpc.fastnear.com', // primary (FastNEAR)
  'https://near-testnet.drpc.org', // independent fallback (dRPC)
  'https://archival-rpc.testnet.fastnear.com', // second fallback (FastNEAR archival)
];

export function rpcUrls(env = process.env) {
  const first = env?.NEAR_RPC_URL?.trim();
  return first ? [first, ...DEFAULT_RPCS.filter((u) => u !== first)] : [...DEFAULT_RPCS];
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_TEXT = /\b(429|408|50[0234])\b|too many requests|rate.?limit|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|unavailable|bad gateway|RetriesExceeded|Exceeded \d+ attempts/i;

/** True for rate limits, 5xx, timeouts and network failures. False for contract or request errors. */
export function isTransient(err) {
  if (!err) return false;
  if (err.transient === true) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const cause = typeof err.cause === 'number' ? err.cause : err.cause?.status ?? err.status;
  if (TRANSIENT_STATUS.has(cause)) return true;
  if (/Smart contract panicked|MethodNotFound|does not exist|InvalidNonce|AccessKey|NotEnoughBalance/i.test(String(err.message))) return false;
  return TRANSIENT_TEXT.test(`${err.name ?? ''} ${err.message ?? ''} ${err.code ?? ''}`);
}

/** Backoff with full jitter: random in [base*2^n / 2, base*2^n], capped. */
export function backoffMs(attempt, { baseMs = 500, capMs = 8_000, random = Math.random } = {}) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON-RPC call with failover. On a transient failure it waits (backoff + jitter) and moves to
 * the next endpoint. A JSON-RPC error that is not transient (e.g. a contract panic) is thrown at once.
 * onEvent receives { type: 'retry' | 'switch', url, error, attempt } for counting.
 */
export async function rpcRequest(method, params, {
  urls = rpcUrls(), fetchImpl = fetch, maxAttempts = 6, timeoutMs = 15_000, wait = sleep, random = Math.random, onEvent = () => {},
} = {}) {
  let last;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'alltrades', method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (TRANSIENT_STATUS.has(res.status)) throw Object.assign(new Error(`RPC HTTP ${res.status} from ${url}`), { transient: true, status: res.status });
      const j = await res.json();
      if (j.error) {
        const e = new Error(`RPC error: ${JSON.stringify(j.error).slice(0, 200)}`);
        const code = j.error.code;
        if (code === -429 || /TIMEOUT_ERROR|Too many requests/i.test(JSON.stringify(j.error))) e.transient = true;
        throw e;
      }
      if (j.result?.error) throw new Error(`Contract error: ${String(j.result.error).slice(0, 200)}`);
      return j.result;
    } catch (err) {
      last = err;
      if (!isTransient(err)) throw err;
      const next = urls[(attempt + 1) % urls.length];
      onEvent({ type: 'retry', url, error: String(err.message).slice(0, 120), attempt });
      if (next !== url) onEvent({ type: 'switch', from: url, to: next, attempt });
      if (attempt < maxAttempts - 1) await wait(backoffMs(attempt, { random }));
    }
  }
  throw Object.assign(new Error(`RPC unavailable after ${maxAttempts} attempts: ${String(last?.message).slice(0, 160)}`), { transient: true });
}

/** Read-only contract view over rpcRequest. Returns the decoded JSON result. */
export async function viewFunction(contractId, method, args = {}, opts = {}) {
  const r = await rpcRequest('query', {
    request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  }, opts);
  return JSON.parse(Buffer.from(r.result).toString() || 'null');
}

/**
 * One near-api-js JsonRpcProvider per endpoint, for signing. Writes are NOT retried here: a
 * caller that gets a transient error must re-read chain state before sending again, and the
 * next send goes to the next endpoint (rotate()). near-api-js's FailoverRpcProvider is not used
 * because it prints every error to stderr and also fails over on contract errors.
 */
export async function signingProviders(urls = rpcUrls()) {
  const { JsonRpcProvider } = await import('near-api-js');
  const list = urls.map((url) => ({ url, provider: new JsonRpcProvider({ url }, { retries: 2, wait: 500, backoff: 2 }) }));
  let i = 0;
  return {
    get current() { return list[i]; },
    rotate() { const from = list[i].url; i = (i + 1) % list.length; return { from, to: list[i].url }; },
    all: list,
  };
}
