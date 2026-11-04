// Remit agent CLI: Vietnamese request → TransferOrder draft + sourced cost context.
//   node agent/remit.mjs "Gửi 500 đô về cho mẹ"              # live: 1Click dry quote + open.er-api.com
//   node agent/remit.mjs --fixtures "Gửi 500 đô về cho mẹ"   # offline: synthetic fixtures, no network
//   node agent/remit.mjs --contract <CONTRACT_ID> "..."      # draft for your own contract
// Prints to stdout only. Writes no files, signs nothing, sends no transaction.

import { readFileSync } from 'node:fs';
import { checkQuality, loadPacks } from './lib.mjs';
import { buildComparison, fetchReferenceRate, loadWorldBankCorridor, renderComparison } from './quotes/comparison.mjs';
import { getDryQuote } from './quotes/intents.mjs';
import { draftTransferOrder } from './remit/draft.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./quotes/fixtures/${name}`, import.meta.url), 'utf8'));
const fixtureFetch = (name) => async () => ({ ok: true, json: async () => fixture(name) });

export async function runRemit(message, { offline = false, now = Date.now(), salt, contractId } = {}) {
  const pack = loadPacks(new URL('../packs', import.meta.url).pathname).get('remit');
  const draft = draftTransferOrder(message, { now, ...(salt ? { salt } : {}), ...(contractId ? { contractId } : {}) });
  if (!draft.ok) return { draft, comparison: null, summary: null };

  const amountUsd = draft.request.amount_usd;
  const warnings = [];
  const attempt = async (label, fn) => {
    try { return await fn(); } catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
  };
  const corridor = await attempt('World Bank', () => loadWorldBankCorridor());
  const fx = await attempt('ExchangeRate-API', () => fetchReferenceRate(offline ? { fetchImpl: fixtureFetch('er-api-usd.json') } : {}));
  const quote = await attempt('1Click', () => getDryQuote({ from: 'USDC', to: 'USDT', amount: amountUsd },
    offline ? { fetchImpl: fixtureFetch('oneclick-dry-quote.json'), now } : { now }));

  if (offline) for (const x of [fx, quote]) if (x) x.fixture = true;
  const comparison = buildComparison({ amountUsd, corridor, fx, quote });
  const summary = renderComparison(comparison);
  const quality = checkQuality(summary, pack);
  if (!quality.ok) throw new Error(`Remit summary failed the payments-info gate: ${quality.reason}`);
  return { draft, comparison, summary, warnings, offline };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const offline = args.includes('--fixtures');
  const ci = args.indexOf('--contract');
  const contractId = ci >= 0 ? args[ci + 1] : undefined;
  const skip = new Set(ci >= 0 ? [ci, ci + 1] : []);
  const message = args.filter((a, i) => a !== '--fixtures' && !skip.has(i)).join(' ');
  if (!message || (ci >= 0 && !contractId)) { console.error('Usage: node agent/remit.mjs [--fixtures] [--contract <CONTRACT_ID>] "Gửi 500 đô về cho mẹ"'); process.exit(2); }
  const out = await runRemit(message, { offline, contractId });
  if (offline) console.log('[fixtures: synthetic data, no network]\n');
  console.log(JSON.stringify(out.draft, null, 2));
  if (out.summary) console.log(`\n${out.summary}`);
  for (const w of out.warnings ?? []) console.log(`(cảnh báo) ${w}`);
}
