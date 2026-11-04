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
  assert.match(html, /test\.rpc\.fastnear\.com/);
  assert.match(html, /near-testnet\.drpc\.org/);
  assert.ok(!/rpc\.mainnet|rpc\.near\.org['"]/.test(html), 'no mainnet RPC');
});
test('dashboard folder holds only public static files', () => {
  const files = readdirSync('dashboard', { recursive: true });
  for (const f of files) assert.ok(/\.(html|json)$/.test(f) || f === 'data', `unexpected file ${f}`);
});
test('dashboard pages fail over between testnet RPCs and never use the deprecated endpoint as a target', () => {
  for (const f of ['dashboard/index.html', 'dashboard/remit.html']) {
    const page = read(f);
    assert.match(page, /async function rpcQuery/, f);
    assert.match(page, /TRANSIENT = new Set\(\[408, 425, 429, 500, 502, 503, 504\]\)/, f);
    assert.ok(!/fetch\(['"]https:\/\/rpc\.testnet\.near\.org/.test(page) && !page.includes("'https://rpc.testnet.near.org'"), f);
  }
});
const ap = read('dashboard/autopilot.html');
test('autopilot page reads live data from the three views and shows the required labels', () => {
  for (const m of ["view('get_autopilot')", "view('get_industries')", "view('get_jobs_v2'"]) assert.ok(ap.includes(m), m);
  for (const s of ['Testnet.', 'Simulated clients.', 'No external marketplace.', 'Owner arbitration is demo-only.']) assert.ok(ap.includes(s), s);
  for (const s of ['Deliveries today', 'Revenue', 'Escrow', 'Worker account', 'Autopilot']) assert.ok(ap.includes(s), s);
});
test('autopilot page hard-codes no revenue, escrow or balance figures', () => {
  const script = ap.slice(ap.indexOf('<script>'));
  assert.ok(!/\b3\.6|\b2\.3|\b0\.95\b|\d{22,}/.test(script), 'no ledger numbers in code');
});
test('autopilot page: no wallet, no storage, no deliverable text, testnet failover only', () => {
  assert.ok(!/localStorage|sessionStorage|indexedDB|wallet-selector|near-connect|signIn/i.test(ap));
  assert.ok(!/\.text\b|deliverable_text|brief:/.test(ap.slice(ap.indexOf('<script>'))), 'never renders deliverable or brief text');
  assert.match(ap, /async function rpcQuery/);
  assert.ok(!/rpc\.mainnet|near\.org['"]/.test(ap));
});
test('autopilot tx map holds only testnet tx hashes for known actions', () => {
  const t = JSON.parse(read('dashboard/data/autopilot-txs.json'));
  const allowed = new Set(['create', 'deliver', 'dispute', 'resolve', 'cancel', 'finalize']);
  for (const v of Object.values(t.jobs)) for (const [k, h] of Object.entries(v)) {
    assert.ok(allowed.has(k), k);
    assert.match(h, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  }
});
test('every dashboard page links to the others', () => {
  for (const f of ['dashboard/index.html', 'dashboard/remit.html', 'dashboard/autopilot.html']) {
    const p = read(f);
    for (const href of ['./"', './remit.html', './autopilot.html']) assert.ok(p.includes(`href="${href.replace('"', '')}`) || p.includes(`href="${href}`), `${f} → ${href}`);
  }
});
