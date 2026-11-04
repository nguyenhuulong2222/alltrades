import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };

const { callArgs, parseCliOutput, nearCall, CLIENT } = await import('./common.mjs');
const { checkChain, checkWorkerReports, parseWorkerLog } = await import('./invariants.mjs');
const { PLAN } = await import('./client.mjs');

const N = (x) => (BigInt(Math.round(x * 1000)) * 10n ** 21n).toString();
const job = (id, status, amount = 0.2) => ({ id, status, amount: N(amount) });
const base = () => ({
  core: { total_revenue: N(2.3), withdrawn: '0' },
  industries: [['beauty', { revenue: N(1.05) }], ['fitness', { revenue: N(0.25) }], ['real-estate', { revenue: N(1) }], ['food', { revenue: N(0) }]],
  jobs: [job(0, 'Paid', 0.25), job(1, 'Refunded', 0.25), job(2, 'Open', 0.15)],
  balances: { contract: N(12), client: N(7), worker: N(10), owner: N(5) },
  allowance: N(0.999), autopilot: { delivered_today: 2, max_deliveries_per_day: 10 },
});
const clone = (x) => structuredClone(x);

// ---------- near-cli wrapper ----------

test('callArgs builds a testnet keychain call with explicit gas and deposit', () => {
  const a = callArgs({ method: 'create_job_v2', args: { industry: 'beauty' }, signer: CLIENT, deposit: '0.2 NEAR' });
  assert.deepEqual(a.slice(0, 5), ['contract', 'call-function', 'as-transaction', 'alltrades-long2222.testnet', 'create_job_v2']);
  assert.ok(a.includes('testnet') && a.includes('sign-with-keychain') && a.includes('0.2 NEAR') && a.includes('30 Tgas'));
  assert.ok(!a.join(' ').includes('mainnet'));
});
test('parseCliOutput returns only the tx hash or the contract error, never raw output', () => {
  const ok = parseCliOutput('│ Transaction ID: 7jG2ZKZbuW9TkcTwoQz7hbAqwPkQ3w5jAdZ82fcucGGR\nsecret stuff');
  assert.deepEqual(ok, { tx: '7jG2ZKZbuW9TkcTwoQz7hbAqwPkQ3w5jAdZ82fcucGGR', error: null, transient: false });
  const bad = parseCliOutput('Error: ... ExecutionError("Smart contract panicked: Review window has closed")');
  assert.equal(bad.error, 'Review window has closed');
  const other = parseCliOutput('Error: keychain locked private_key=ed25519:abc');
  assert.equal(other.error, 'near-cli error (details withheld)');
});
test('nearCall throws a short error and never leaks near-cli output', async () => {
  const fail = async () => { const e = new Error('x'); e.stdout = 'seed phrase here'; e.stderr = 'Error: boom'; throw e; };
  await assert.rejects(nearCall({ method: 'm', args: {}, signer: CLIENT }, fail), (e) => e.message === 'm: near-cli error (details withheld)');
  const ok = async () => ({ stdout: 'Transaction ID: 7jG2ZKZbuW9TkcTwoQz7hbAqwPkQ3w5jAdZ82fcucGGR', stderr: '' });
  assert.equal(await nearCall({ method: 'm', args: {}, signer: CLIENT }, ok), '7jG2ZKZbuW9TkcTwoQz7hbAqwPkQ3w5jAdZ82fcucGGR');
});

// ---------- chain invariants ----------

test('a consistent run passes: new job delivered, paid, another cancelled', () => {
  const b = base();
  const n = clone(b);
  n.jobs = [job(0, 'Paid', 0.25), job(1, 'Refunded', 0.25), job(2, 'Paid', 0.15), job(3, 'Delivered', 0.2), job(4, 'Cancelled', 0.15)];
  n.core.total_revenue = N(2.45);
  n.industries[3][1].revenue = N(0.15);
  n.balances.contract = N(12.2003); // +0.2 (job 3) +0.15 -0.15 (job 4) + small gas rewards
  assert.deepEqual(checkChain(b, n, new Map(), 0).trips, []);
});
test('trips when a job stays in Cancelling for over 2 minutes', () => {
  const b = base();
  const n = clone(b);
  n.jobs.push(job(3, 'Cancelling'));
  n.balances.contract = N(12.2);
  const seen = new Map();
  assert.deepEqual(checkChain(b, n, seen, 0).trips, []);
  assert.deepEqual(checkChain(b, n, seen, 119_000).trips, []);
  assert.match(checkChain(b, n, seen, 121_000).trips[0], /job 3 stuck in Cancelling/);
});
test('trips on revenue that does not match Paid jobs or the industries', () => {
  const b = base();
  const n = clone(b);
  n.core.total_revenue = N(2.5);
  const t = checkChain(b, n, new Map(), 0).trips.join('|');
  assert.match(t, /industry revenue/);
  assert.match(t, /total_revenue .* != expected/);
});
test('trips when the contract balance moves without a matching deposit or refund', () => {
  const b = base();
  const n = clone(b);
  n.balances.contract = N(11.9);
  assert.match(checkChain(b, n, new Map(), 0).trips.join('|'), /contract balance delta/);
});
test('trips when the worker allowance drops below 0.9 NEAR or the key disappears', () => {
  const b = base();
  const n = clone(b);
  n.allowance = N(0.899);
  assert.match(checkChain(b, n, new Map(), 0).trips.join('|'), /allowance .* below 0.9 NEAR/);
  n.allowance = null;
  assert.match(checkChain(b, n, new Map(), 0).trips.join('|'), /key not found/);
});
test('trips when withdrawn changes', () => {
  const b = base();
  const n = clone(b);
  n.core.withdrawn = N(0.1);
  assert.match(checkChain(b, n, new Map(), 0).trips.join('|'), /withdrawn changed/);
});

// ---------- worker log ----------

test('parseWorkerLog splits reports from unexpected lines', () => {
  const { reports, other } = parseWorkerLog('[2026-11-04T10:00:00Z] {"delivered":[3]}\nTypeError: boom\n\n');
  assert.deepEqual(reports, [{ delivered: [3] }]);
  assert.deepEqual(other, ['TypeError: boom']);
});
test('three NEAR AI failures in a row trip; a delivery in between resets the count', () => {
  const ai = { failed: [{ step: 'generate', reason: 'NEAR AI timed out after 120s' }] };
  assert.deepEqual(checkWorkerReports([ai, ai, { delivered: [1] }, ai]), []);
  assert.match(checkWorkerReports([ai, { failed: [] }, ai, ai]).join('|'), /NEAR AI failed 3 times in a row/);
});
test('the same unexpected error three times trips', () => {
  const e = { failed: [{ step: 'submit', reason: 'RPC timeout' }] };
  assert.match(checkWorkerReports([e, e, e]).join('|'), /repeated error x3: submit: RPC timeout/);
  assert.deepEqual(checkWorkerReports([e, e]), []);
});

// ---------- plan ----------

test('plan: 6 jobs from 4 briefs, 0.15–0.25 NEAR, one dispute, one cancel, within the delivery budget', () => {
  assert.equal(PLAN.length, 6);
  assert.equal(new Set(PLAN.map((p) => p.brief)).size, 4);
  for (const p of PLAN) {
    const n = Number.parseFloat(p.deposit);
    assert.ok(n >= 0.15 && n <= 0.25, p.deposit);
  }
  assert.equal(PLAN.filter((p) => p.dispute).length, 1);
  assert.equal(PLAN.filter((p) => p.cancelDuringStop).length, 1);
  const deliveries = 1 /* waiting job 2 */ + PLAN.filter((p) => !p.cancelDuringStop).length;
  assert.ok(2 + deliveries <= 10, 'already 2 delivered today; contract allows 10');
  assert.ok(Math.max(...PLAN.map((p) => p.at)) + 15 < 180, 'last job can be delivered and finalized inside 3 hours');
});
test('soak scripts never read .env and never print near-cli output', () => {
  for (const f of ['common.mjs', 'client.mjs', 'monitor.mjs', 'invariants.mjs', 'baseline.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.ok(!/readFileSync\([^)]*\.env|process\.env\.(NEAR_AI|WORKER_FC|AGENT_FC|AGENT_MARKET)/.test(src), `${f} reads secrets`);
    assert.ok(!/console\.log\((r|out)\.std/.test(src), `${f} prints near-cli output`);
  }
});

// ---------- transient RPC handling ----------

test('one or a few transient RPC errors never trip; five in a row do; a good pass resets', () => {
  const t = (n) => ({ transient_error: 'RPC HTTP 429', consecutive: n });
  assert.deepEqual(checkWorkerReports([t(1)]), []);
  assert.deepEqual(checkWorkerReports([t(1), t(2), { delivered: [], finalized: [] }, t(1), t(2), t(3), t(4)]), []);
  assert.match(checkWorkerReports([t(1), t(2), t(3), t(4), t(5)]).join('|'), /5 transient RPC errors in a row/);
  const tf = { failed: [{ step: 'submit', reason: 'RPC HTTP 429', transient: true }] };
  assert.deepEqual(checkWorkerReports([tf, tf, tf, tf]), [], 'transient submit failures are retried, not counted as repeats');
});
test('a fatal worker error trips', () => {
  assert.match(checkWorkerReports([{ fatal: 'Smart contract panicked: x' }]).join('|'), /worker fatal error/);
});
test('near-cli transient errors are flagged; contract panics are not', () => {
  assert.equal(parseCliOutput('Error: Too Many Requests 429').transient, true);
  assert.equal(parseCliOutput('Error: ... Smart contract panicked: Job is not open').transient, false);
});
test('sendVerified: a retried create that already landed is not sent again', async () => {
  const { sendVerified } = await import('./common.mjs');
  let sends = 0;
  const send = async () => { sends++; throw Object.assign(new Error('create_job_v2: near-cli transient RPC error'), { transient: true }); };
  const r = await sendVerified('create_job_v2', send, async () => true, { wait: async () => {} });
  assert.equal(r, 'landed-before-retry');
  assert.equal(sends, 1);
});
test('sendVerified: resends only after verify says it did not land, and gives up after 4 tries', async () => {
  const { sendVerified } = await import('./common.mjs');
  let sends = 0;
  const send = async () => { sends++; if (sends < 3) throw Object.assign(new Error('x'), { transient: true }); return 'TX'; };
  assert.equal(await sendVerified('m', send, async () => false, { wait: async () => {} }), 'TX');
  assert.equal(sends, 3);
  let n = 0;
  const always = async () => { n++; throw Object.assign(new Error('x'), { transient: true }); };
  await assert.rejects(sendVerified('m', always, async () => false, { wait: async () => {} }));
  assert.equal(n, 4);
  const hard = async () => { throw new Error('Smart contract panicked'); };
  await assert.rejects(sendVerified('m', hard, async () => false, { wait: async () => {} }), /panicked/);
});
