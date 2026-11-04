// NEAR Intents 1Click: dry quotes only.
// This module can only POST /v0/quote with dry:true. It has no code path to deposit,
// submit or execute a swap. Quote data is returned in memory and never written anywhere
// (1Click terms forbid storing API data for more than 24 hours).

export const ONECLICK_BASE = 'https://1click.chaindefuser.com';
export const QUOTE_PATH = '/v0/quote';
// The all-zero implicit account: a valid format that belongs to nobody, so no real address is sent.
export const NOBODY = '0'.repeat(64);

export const ASSETS = {
  USDC: { id: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 },
  USDT: { id: 'nep141:usdt.tether-token.near', decimals: 6 },
  wNEAR: { id: 'nep141:wrap.near', decimals: 24 },
};

export function toUnits(amount, decimals) {
  const [whole, frac = ''] = String(amount).split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

/** Builds the request body. `dry` is always true; callers cannot override it. */
export function buildDryQuoteRequest({ from = 'USDC', to = 'USDT', amount, now = Date.now() }) {
  const a = ASSETS[from], b = ASSETS[to];
  if (!a || !b) throw new Error(`Unsupported asset pair ${from}→${to}`);
  if (!(Number(amount) > 0)) throw new Error('Quote amount must be above zero');
  return {
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: a.id,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: b.id,
    amount: toUnits(amount, a.decimals),
    refundTo: NOBODY,
    refundType: 'ORIGIN_CHAIN',
    recipient: NOBODY,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 30 * 60_000).toISOString(),
    dry: true,
  };
}

/** Sends a dry quote and returns a short in-memory summary. Throws if anything looks non-dry. */
export async function getDryQuote(params, { fetchImpl = fetch, now = Date.now(), timeoutMs = 15_000 } = {}) {
  const body = buildDryQuoteRequest({ ...params, now });
  if (body.dry !== true) throw new Error('Refusing to send a non-dry quote');
  const url = ONECLICK_BASE + QUOTE_PATH;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`1Click dry quote HTTP ${res.status}`);
  const json = await res.json();
  const q = json?.quote;
  if (!q) throw new Error('1Click dry quote returned no quote');
  if (q.depositAddress) throw new Error('1Click returned a deposit address for a dry quote; discarding it');
  return {
    source: '1Click dry quote (NEAR Intents)',
    pair: `${params.from ?? 'USDC'}→${params.to ?? 'USDT'} on NEAR`,
    amountIn: q.amountInFormatted,
    amountOut: q.amountOutFormatted,
    amountInUsd: q.amountInUsd,
    amountOutUsd: q.amountOutUsd,
    timeEstimateSec: q.timeEstimate,
    fetchedAt: new Date(now).toISOString(),
  };
}
