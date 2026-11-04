import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };
const { buildAuditDemo } = await import('./remit/audit-demo.mjs');

const read = (p) => readFileSync(p, 'utf8');
const html = read('dashboard/remit.html');

test('dashboard World Bank file is the same sample as the agent copy', () => {
  assert.deepEqual(JSON.parse(read('dashboard/data/worldbank-rpw-usa-vnm.sample.json')), JSON.parse(read('agent/quotes/data/worldbank-rpw-usa-vnm.sample.json')));
  assert.equal(JSON.parse(read('dashboard/data/worldbank-rpw-usa-vnm.sample.json')).sample, true);
});
test('audit demo file is up to date with the agent rules', () => {
  assert.deepEqual(JSON.parse(read('dashboard/data/remit-audit-demo.json')), buildAuditDemo());
});
test('audit demo has refusals, no personal data and no 1Click data', () => {
  const text = read('dashboard/data/remit-audit-demo.json');
  const d = JSON.parse(text);
  assert.ok(d.entries.filter((e) => e.outcome === 'refused').length >= 5);
  assert.ok(!/0912|345 678|\d{8,}|@[a-z]+\./i.test(text), 'no phone, account number or email');
  assert.ok(!/amountIn|amountOut|depositAddress|correlationId|chaindefuser/i.test(text), 'no 1Click data');
});
test('tx map only holds testnet transaction hashes', () => {
  const t = JSON.parse(read('dashboard/data/remit-txs.json'));
  for (const o of Object.values(t.orders)) for (const h of Object.values(o)) assert.match(h, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});
test('Remit page shows the required labels', () => {
  for (const s of ['Simulated', 'Không phải dịch vụ chuyển tiền', 'ước tính, không phải báo giá trực tiếp', 'MẪU', 'Rates By Exchange Rate API', 'Kỳ dữ liệu']) {
    assert.ok(html.includes(s), `missing label: ${s}`);
  }
});
test('Remit page: dry quote only, no storage, no wallet, testnet RPC', () => {
  assert.match(html, /dry: true/);
  assert.ok(!html.includes('deposit' + '/submit'));
  assert.ok(!/localStorage|sessionStorage|indexedDB|caches\.open|serviceWorker/.test(html), 'no persistent storage');
  assert.ok(!/wallet-selector|near-connect|signIn|requestSignIn/i.test(html), 'no wallet');
  assert.match(html, /rpc\.testnet\.near\.org/);
  assert.ok(!/rpc\.mainnet|rpc\.near\.org['"]/.test(html), 'no mainnet RPC');
});
test('dashboard folder holds only public static files', () => {
  const files = readdirSync('dashboard', { recursive: true });
  for (const f of files) assert.ok(/\.(html|json)$/.test(f) || f === 'data', `unexpected file ${f}`);
});
