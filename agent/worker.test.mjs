import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };

const { loadPacks, sha256, toYocto } = await import('./lib.mjs');
const { loadBriefs, validateBrief } = await import('./autopilot/briefs.mjs');
const { runOnce, MAX_DELIVERABLE_BYTES } = await import('./autopilot/core.mjs');
const { acquireLock, readState, writeState } = await import('./autopilot/state.mjs');
const { runLoop } = await import('./worker.mjs');

const packs = loadPacks('packs');
const briefs = loadBriefs('briefs', { industries: new Set(packs.keys()) });
const T0 = Date.parse('2026-11-07T20:00:00Z');
const NS = (ms) => (BigInt(ms) * 1_000_000n).toString();
const REVIEW_MS = 600_000;
const GOOD = 'Fictional demo copy for a small business. Warm, clear and short, with one simple call to action at the end.';

/** In-memory stand-in for the Jobs v2 contract, enforcing the same rules the worker relies on. */
function fakeChain({ paused = false, clock } = {}) {
  const jobs = new Map();
  const calls = { views: 0, submit: [], finalize: [] };
  let next = 0;
  const c = {
    jobs, calls,
    cfg: () => ({ paused, next_job_id: next, review_window_secs: REVIEW_MS / 1000 }),
    setPaused(p) { paused = p; },
    add(briefId, industry = briefs.get(briefId)?.industry ?? 'beauty', hash = briefs.get(briefId)?.hash ?? 'f'.repeat(64)) {
      const id = next++;
      jobs.set(id, { id, industry, brief_id: briefId, brief_hash: hash, status: 'Open', review_deadline_ns: null });
      return id;
    },
    async getAutopilot() { calls.views++; return c.cfg(); },
    async getJob(id) { calls.views++; return structuredClone(jobs.get(id) ?? null); },
    async getJobs(from, limit) { calls.views++; return [...jobs.values()].filter((j) => j.id >= from && j.id < from + Math.min(limit, 50)).map((j) => structuredClone(j)); },
    async getOpenJobs(from, limit) { return (await c.getJobs(from, limit)).filter((j) => j.status === 'Open'); },
    async submitDelivery({ jobId, hash, cost, text }) {
      calls.submit.push({ jobId, hash, cost, text });
      const j = jobs.get(jobId);
      if (paused) throw new Error('Autopilot is paused');
      if (j.status !== 'Open') throw new Error('Smart contract panicked: Job is not open');
      if (sha256(text) !== hash) throw new Error('deliverable_hash does not match text');
      if (Buffer.byteLength(text) > 4096) throw new Error('Deliverable must be 1-4096 bytes');
      Object.assign(j, { status: 'Delivered', review_deadline_ns: NS(clock() + REVIEW_MS) });
      return `tx-submit-${jobId}`;
    },
    async finalize(id) {
      calls.finalize.push(id);
      const j = jobs.get(id);
      if (paused) throw new Error('Autopilot is paused');
      if (j.status !== 'Delivered') throw new Error('Only a Delivered job can be finalized');
      if (BigInt(j.review_deadline_ns) > BigInt(NS(clock()))) throw new Error('Review window is still open');
      j.status = 'Paid';
      return `tx-final-${id}`;
    },
  };
  return c;
}

function harness({ limits, paused, text = GOOD } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alltrades-worker-'));
  let now = T0;
  const clock = () => now;
  const chain = fakeChain({ paused, clock });
  const ai = { calls: 0, text };
  const generate = async () => { ai.calls++; if (ai.text instanceof Error) throw ai.text; return typeof ai.text === 'function' ? ai.text() : ai.text; };
  const ctx = { chain, generate, briefs, packs, statePath: join(dir, 'state.json'), stopPath: join(dir, 'STOP'), limits, now: clock };
  return { dir, chain, ai, ctx, advance: (ms) => { now += ms; }, run: () => runOnce(ctx), state: () => readState(ctx.statePath) };
}

// ---------- catalog ----------

test('catalog: four fictional briefs, hash is SHA-256 of the brief text', () => {
  assert.deepEqual([...briefs.keys()].sort(), ['kapalua-condo-listing', 'lani-nails-fall', 'makai-fit-class', 'pho-lani-review']);
  for (const b of briefs.values()) {
    assert.equal(b.fictional, true);
    assert.equal(b.hash, sha256(b.brief));
    assert.ok(packs.has(b.industry));
  }
});
test('catalog refuses non-fictional briefs, personal data, long text and unknown industries', () => {
  const ok = { id: 'x', industry: 'beauty', fictional: true, brief: 'Fictional salon post.' };
  const inds = new Set(packs.keys());
  assert.throws(() => validateBrief({ ...ok, fictional: false }), /fictional/);
  assert.throws(() => validateBrief({ ...ok, brief: 'Call Jane at 808-555-0100' }), /personal data \(phone\)/);
  assert.throws(() => validateBrief({ ...ok, brief: 'Email jane@example.com' }), /personal data \(email\)/);
  assert.throws(() => validateBrief({ ...ok, brief: 'Account 0011001234567' }), /personal data \(long_number\)/);
  assert.throws(() => validateBrief({ ...ok, brief: 'a'.repeat(1001) }), /over 1000/);
  assert.throws(() => validateBrief({ ...ok, industry: 'tax' }, { industries: inds }), /unknown industry/);
  assert.throws(() => validateBrief({ ...ok, id: 'Jane Doe' }), /Brief id/);
});
test('catalog file name must match the brief id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alltrades-briefs-'));
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ id: 'x', industry: 'beauty', fictional: true, brief: 'Fictional.' }));
  assert.throws(() => loadBriefs(dir), /must be named x\.json/);
});

// ---------- happy path ----------

test('finds Open jobs, works only on catalog briefs, delivers with hash, cost and text', async () => {
  const h = harness();
  const a = h.chain.add('lani-nails-fall');
  const b = h.chain.add('pho-lani-review');
  const r = await h.run();
  assert.deepEqual(r.delivered, [a, b]);
  assert.equal(h.ai.calls, 2);
  const s = h.chain.calls.submit[0];
  assert.equal(s.hash, sha256(GOOD));
  assert.equal(s.text, GOOD);
  assert.equal(s.cost, toYocto(packs.get('beauty').max_cost_near));
  const st = h.state();
  assert.equal(st.jobs[a].status, 'delivered');
  assert.equal(st.jobs[a].review_deadline_ns, NS(T0 + REVIEW_MS));
});
test('skips jobs whose brief is unknown, has the wrong hash, or the wrong industry; no model call', async () => {
  const h = harness();
  const unknown = h.chain.add('not-in-catalog', 'beauty', 'a'.repeat(64));
  const wrongHash = h.chain.add('lani-nails-fall', 'beauty', 'b'.repeat(64));
  const wrongIndustry = h.chain.add('lani-nails-fall', 'food', briefs.get('lani-nails-fall').hash);
  const r = await h.run();
  assert.equal(h.ai.calls, 0);
  assert.deepEqual(r.skipped.map((x) => [x.id, x.reason]), [
    [unknown, 'brief_id is not in the catalog'],
    [wrongHash, 'brief_hash does not match the catalog'],
    [wrongIndustry, 'brief industry does not match the job'],
  ]);
  await h.run();
  assert.equal(h.ai.calls, 0, 'skipped jobs are not retried');
});

// ---------- limits ----------

test('maxJobsPerRun limits the work done in one pass', async () => {
  const h = harness({ limits: { maxJobsPerRun: 1 } });
  h.chain.add('lani-nails-fall');
  h.chain.add('pho-lani-review');
  assert.equal((await h.run()).delivered.length, 1);
  assert.equal(h.ai.calls, 1);
  assert.equal((await h.run()).delivered.length, 1);
});
test('daily cost budget stops work and resets the next day', async () => {
  const cost = packs.get('beauty').max_cost_near;
  const h = harness({ limits: { maxCostNearPerDay: cost * 2, maxJobsPerRun: 10 } });
  for (let i = 0; i < 3; i++) h.chain.add('lani-nails-fall');
  const r = await h.run();
  assert.equal(r.delivered.length, 2);
  assert.match(r.stopped, /daily cost budget/);
  h.advance(24 * 3600_000);
  assert.equal((await h.run()).delivered.length, 1);
});

// ---------- stop and pause ----------

test('agent/STOP stops the worker before any chain or model call', async () => {
  const h = harness();
  h.chain.add('lani-nails-fall');
  writeFileSync(h.ctx.stopPath, '');
  const r = await h.run();
  assert.equal(r.stopped, 'STOP file present');
  assert.equal(h.chain.calls.views, 0);
  assert.equal(h.ai.calls, 0);
});
test('a paused contract means no work, no delivery and no finalize', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  await h.run();
  h.chain.setPaused(true);
  h.chain.add('pho-lani-review');
  h.advance(REVIEW_MS + 1);
  const r = await h.run();
  assert.equal(r.paused, true);
  assert.equal(h.ai.calls, 1);
  assert.deepEqual(h.chain.calls.finalize, []);
  assert.equal(h.chain.jobs.get(id).status, 'Delivered');
});

// ---------- finalize ----------

test('finalizes only after the review window, exactly once', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  await h.run();
  h.advance(REVIEW_MS - 1);
  await h.run();
  assert.deepEqual(h.chain.calls.finalize, []);
  h.advance(1);
  const r = await h.run();
  assert.deepEqual(r.finalized, [id]);
  await h.run();
  assert.deepEqual(h.chain.calls.finalize, [id]);
  assert.equal(h.chain.jobs.get(id).status, 'Paid');
  assert.equal(h.state().jobs[id].status, 'finalized');
});
test('finalize is driven by the chain, so a lost state file does not strand a payment', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  await h.run();
  writeFileSync(h.ctx.statePath, JSON.stringify({ version: 1, day: null, costTodayNear: 0, jobs: {} }));
  h.advance(REVIEW_MS);
  assert.deepEqual((await h.run()).finalized, [id]);
  assert.equal(h.ai.calls, 1, 'no work repeated');
});

// ---------- restart safety ----------

test('restart: a job left in progress that the chain shows Delivered is not redone', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  h.chain.jobs.get(id).status = 'Delivered';
  h.chain.jobs.get(id).review_deadline_ns = NS(T0 + REVIEW_MS);
  writeState(h.ctx.statePath, { version: 1, day: null, costTodayNear: 0, jobs: { [id]: { status: 'in_progress', attempts: 1 } } });
  const r = await h.run();
  assert.equal(h.ai.calls, 0);
  assert.deepEqual(r.recovered, [{ id, status: 'delivered' }]);
  assert.deepEqual(h.chain.calls.submit, []);
});
test('restart: a job interrupted before delivery is retried once, then given up', async () => {
  const h = harness({ limits: { maxAttempts: 2 }, text: new Error('model down') });
  const id = h.chain.add('lani-nails-fall');
  writeState(h.ctx.statePath, { version: 1, day: null, costTodayNear: 0, jobs: { [id]: { status: 'in_progress', attempts: 1 } } });
  await h.run();
  assert.equal(h.ai.calls, 1);
  assert.equal(h.state().jobs[id].attempts, 2);
  await h.run();
  assert.equal(h.ai.calls, 1, 'no third attempt');
});
test('a submit that reached the chain but errored locally is reconciled, not redone', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  const real = h.chain.submitDelivery;
  h.chain.submitDelivery = async (args) => { await real(args); throw new Error('RPC timeout'); };
  const r1 = await h.run();
  assert.equal(r1.failed[0].step, 'submit');
  h.chain.submitDelivery = real;
  const r2 = await h.run();
  assert.deepEqual(r2.recovered, [{ id, status: 'delivered' }]);
  assert.equal(h.ai.calls, 1);
  assert.equal(h.chain.calls.submit.length, 1);
});
test('a job the client cancelled meanwhile is closed, not retried', async () => {
  const h = harness();
  const id = h.chain.add('lani-nails-fall');
  h.ai.text = () => { h.chain.jobs.get(id).status = 'Cancelled'; return GOOD; };
  const r = await h.run();
  assert.match(r.failed[0].reason, /Job is not open/);
  assert.equal(h.state().jobs[id].status, 'closed');
  await h.run();
  assert.equal(h.ai.calls, 1);
});
test('corrupt state is an error, not a silent reset', () => {
  const h = harness();
  writeFileSync(h.ctx.statePath, '{"not":"state"}');
  assert.throws(() => h.state(), /Unrecognized worker state/);
});

// ---------- delivery checks ----------

test('quality failure, model error or oversize text: nothing is submitted', async () => {
  for (const [text, re] of [['short', /quality gate: too_short/], [new Error('NEAR AI timed out'), /timed out/], ['a '.repeat(2100), /quality gate|over 4096/]]) {
    const h = harness({ text });
    h.chain.add('lani-nails-fall');
    const r = await h.run();
    assert.deepEqual(h.chain.calls.submit, []);
    assert.match(r.failed[0].reason, re);
  }
});
test('oversize text is refused by the worker even when the pack allows it', async () => {
  const big = 'Fictional demo copy. '.repeat(Math.ceil((MAX_DELIVERABLE_BYTES + 10) / 21));
  const packsBig = new Map([...packs].map(([k, p]) => [k, { ...p, quality: { ...p.quality, max_chars: 100_000 } }]));
  const h = harness({ text: big });
  h.ctx.packs = packsBig;
  h.chain.add('lani-nails-fall');
  const r = await h.run();
  assert.match(r.failed[0].reason, /over 4096 bytes/);
  assert.deepEqual(h.chain.calls.submit, []);
});

// ---------- process safety ----------

test('only one worker can hold the lock; a stale lock is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alltrades-lock-'));
  const lock = join(dir, 'lock');
  const release = acquireLock(lock);
  assert.throws(() => acquireLock(lock, process.pid + 1), /Another worker is running/);
  release();
  writeFileSync(lock, '999999999');
  const r2 = acquireLock(lock);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  r2();
  assert.equal(existsSync(lock), false);
});
test('runLoop stops when agent/STOP appears and at the --until time', async () => {
  const h = harness();
  let passes = 0;
  const r = await runLoop(h.ctx, { intervalMs: 0, wait: async () => { if (++passes === 2) writeFileSync(h.ctx.stopPath, ''); }, now: h.ctx.now });
  assert.equal(r.stopped, 'STOP file present');
  assert.equal(passes, 2);

  const h2 = harness();
  let t = T0;
  const r2 = await runLoop(h2.ctx, { intervalMs: 0, untilMs: T0 + 3, now: () => t, wait: async () => { t += 1; } });
  assert.equal(r2.stopped, 'until reached');
});
test('worker code has no path to cancel, dispute, resolve, withdraw or reconfigure', () => {
  for (const f of ['agent/worker.mjs', 'agent/autopilot/core.mjs', 'agent/autopilot/state.mjs', 'agent/autopilot/briefs.mjs']) {
    const src = readFileSync(f, 'utf8');
    for (const m of ['cancel_job_v2', 'dispute_job_v2', 'resolve_dispute_v2', 'withdraw_revenue', 'set_autopilot', 'set_worker', 'create_job']) {
      assert.ok(!src.includes(m), `${f} mentions ${m}`);
    }
  }
  const worker = readFileSync('agent/worker.mjs', 'utf8');
  assert.match(worker, /checkedKeyPair\(env\.WORKER_FC_PRIVATE_KEY, env\.WORKER_EXPECTED_PUBLIC_KEY\)/);
  assert.ok(!/console\.log\([^)]*PRIVATE_KEY/.test(worker));
});
test('worker state, lock and STOP files are gitignored', () => {
  const gi = readFileSync('.gitignore', 'utf8');
  for (const p of ['.worker-state.json', '.worker.lock', 'agent/STOP']) assert.ok(gi.includes(p), p);
});
test('nearChain builds a signing account from the worker key and refuses a mismatched key', async () => {
  const { KeyPair } = await import('near-api-js');
  const { nearChain } = await import('./worker.mjs');
  const kp = KeyPair.fromRandom('ed25519');
  const env = { CONTRACT_ID: 'c.testnet', WORKER_ID: 'w.testnet', WORKER_FC_PRIVATE_KEY: kp.toString(), WORKER_EXPECTED_PUBLIC_KEY: kp.getPublicKey().toString() };
  const chain = await nearChain(env);
  assert.equal(typeof chain.account.signer?.signTransaction, 'function', 'regression: a raw KeyPair object has no signTransaction');
  const other = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  await assert.rejects(nearChain({ ...env, WORKER_EXPECTED_PUBLIC_KEY: other }), (e) => /key mismatch/.test(e.message) && !e.message.includes(kp.toString()));
  await assert.rejects(nearChain({ ...env, WORKER_FC_PRIVATE_KEY: '' }), /WORKER_FC_PRIVATE_KEY is not set/);
});
