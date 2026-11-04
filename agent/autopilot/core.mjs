// One worker pass over Jobs v2. All I/O is injected (chain, model, clock, files), so the
// whole loop is testable with fixtures and no network.
//
// Order of a pass: STOP file → contract pause → finalize due deliveries (scanned on chain) →
// reconcile jobs a crash or error left behind → discover Open jobs → work and deliver, within limits.
// The worker never cancels, disputes, resolves or withdraws; it has no code for that.

import { existsSync } from 'node:fs';
import { checkQuality, cleanOutput, sha256, toYocto } from '../lib.mjs';
import { readState, writeState } from './state.mjs';
import { isTransient } from '../rpc.mjs';

export const MAX_DELIVERABLE_BYTES = 4096;
export const DEFAULT_LIMITS = { maxJobsPerRun: 3, maxAttempts: 2, maxCostNearPerDay: 0.25 };
const PAGE = 50;
const DONE = new Set(['delivered', 'disputed', 'settled', 'finalized', 'closed', 'skipped']);
/** Local status for a job we delivered, given what the chain shows now (owner rulings, refunds). */
const SYNC = { Disputed: 'disputed', Paid: 'settled', Refunding: 'disputed', Refunded: 'closed', Cancelled: 'closed' };

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const nsOf = (ms) => BigInt(ms) * 1_000_000n;

export async function runOnce({ chain, generate, briefs, packs, statePath, stopPath, limits = {}, now = Date.now, log = () => {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const report = { stopped: null, paused: false, finalized: [], delivered: [], skipped: [], failed: [], recovered: [], synced: [] };
  const stopped = () => {
    if (existsSync(stopPath)) { report.stopped = 'STOP file present'; return true; }
    return false;
  };
  if (stopped()) return report;

  const cfg = await chain.getAutopilot();
  if (!cfg) { report.stopped = 'Autopilot is not configured on the contract'; return report; }
  if (cfg.paused) { report.paused = true; return report; }

  const state = readState(statePath);
  const today = dayOf(now());
  if (state.day !== today) { state.day = today; state.costTodayNear = 0; }
  const save = () => writeState(statePath, state);
  const entry = (id) => (state.jobs[id] ??= { status: 'new', attempts: 0 });

  // 1. Finalize every delivery whose review window has passed. Driven by the chain, not by
  //    local state, so a lost state file cannot strand a payment. Anyone may finalize.
  for (let from = 0; from < Number(cfg.next_job_id); from += PAGE) {
    for (const job of await chain.getJobs(from, PAGE)) {
      // Keep local state in step with the chain for jobs settled without our finalize
      // (a dispute, an owner ruling, a refund).
      const local = state.jobs[job.id];
      if (local && (local.status === 'delivered' || local.status === 'disputed') && SYNC[job.status] && local.status !== SYNC[job.status]) {
        Object.assign(local, { status: SYNC[job.status], chain_status: job.status });
        report.synced.push({ id: job.id, chain_status: job.status });
        save();
      }
      if (job.status !== 'Delivered' || BigInt(job.review_deadline_ns) > nsOf(now())) continue;
      if (stopped()) return report;
      const e = entry(job.id);
      try {
        e.finalize_tx = await chain.finalize(job.id);
        e.status = 'finalized';
        delete e.last_error;
        report.finalized.push(job.id);
      } catch (err) {
        e.last_error = short(err);
        report.failed.push({ id: job.id, step: 'finalize', reason: e.last_error, ...(isTransient(err) ? { transient: true } : {}) });
      }
      save();
    }
  }

  // 2. Reconcile jobs a crashed or failed run touched: never redo work the chain already has.
  for (const [id, e] of Object.entries(state.jobs)) {
    if (e.status !== 'in_progress' && e.status !== 'failed') continue;
    const job = await chain.getJob(Number(id));
    if (job?.status === 'Open') {
      if (e.status === 'in_progress') {
        Object.assign(e, { status: 'failed', last_error: 'interrupted before delivery' });
        report.recovered.push({ id: Number(id), status: e.status });
      }
    } else if (job?.status === 'Delivered') {
      Object.assign(e, { status: 'delivered', review_deadline_ns: job.review_deadline_ns });
      delete e.pending_text;
      report.recovered.push({ id: Number(id), status: e.status });
    } else {
      Object.assign(e, { status: 'closed', chain_status: job?.status ?? 'missing' });
      delete e.pending_text;
      report.recovered.push({ id: Number(id), status: e.status });
    }
    save();
  }

  // 3. Discover Open jobs, oldest first.
  const open = [];
  for (let from = 0; from < Number(cfg.next_job_id); from += PAGE) open.push(...(await chain.getOpenJobs(from, PAGE)));

  // 4. Work and deliver within the limits.
  let worked = 0;
  for (const job of open) {
    const e = entry(job.id);
    if (DONE.has(e.status) || e.status === 'in_progress') continue;
    if (e.attempts >= L.maxAttempts && !e.pending_text) continue;
    if (worked >= L.maxJobsPerRun) break;
    if (stopped()) return report;

    const brief = briefs.get(job.brief_id);
    const pack = packs.get(job.industry);
    const skip = !brief ? 'brief_id is not in the catalog'
      : brief.hash !== job.brief_hash ? 'brief_hash does not match the catalog'
      : brief.industry !== job.industry ? 'brief industry does not match the job'
      : !pack ? 'no pack for this industry' : null;
    if (skip) {
      Object.assign(e, { status: 'skipped', reason: skip });
      report.skipped.push({ id: job.id, reason: skip });
      save();
      continue;
    }
    if (!e.pending_text && state.costTodayNear + pack.max_cost_near > L.maxCostNearPerDay + 1e-9) {
      report.stopped = `daily cost budget of ${L.maxCostNearPerDay} NEAR reached`;
      break;
    }

    // Text generated by an earlier attempt that never reached the chain is reused: no second model call.
    let text = e.pending_text ?? null;
    if (!text) {
      // Record the attempt and its cost before calling the model, so a crash cannot repeat it for free.
      worked += 1;
      e.attempts += 1;
      e.status = 'in_progress';
      state.costTodayNear = round(state.costTodayNear + pack.max_cost_near);
      save();
      try {
        text = cleanOutput(await generate(pack, brief.brief));
        const q = checkQuality(text, pack);
        if (!q.ok) throw new Error(`quality gate: ${q.reason}`);
        if (Buffer.byteLength(text, 'utf8') > MAX_DELIVERABLE_BYTES) throw new Error(`deliverable over ${MAX_DELIVERABLE_BYTES} bytes`);
      } catch (err) {
        Object.assign(e, { status: 'failed', last_error: short(err) });
        report.failed.push({ id: job.id, step: 'generate', reason: e.last_error });
        save();
        continue;
      }
      e.pending_text = text;
      save();
    } else {
      worked += 1;
    }

    try {
      // Re-read the job right before sending: a previous send may have landed, or the client cancelled.
      const fresh = await chain.getJob(job.id);
      if (fresh?.status !== 'Open') {
        const landed = fresh?.status === 'Delivered' && fresh.deliverable_hash === sha256(text);
        Object.assign(e, landed
          ? { status: 'delivered', deliverable_hash: fresh.deliverable_hash, review_deadline_ns: fresh.review_deadline_ns }
          : { status: 'closed', chain_status: fresh?.status ?? 'missing' });
        delete e.pending_text;
        report.skipped.push({ id: job.id, reason: `job is ${fresh?.status ?? 'missing'} on chain; nothing sent` });
        save();
        continue;
      }
      const hash = sha256(text);
      e.submit_tx = await chain.submitDelivery({ jobId: job.id, hash, cost: toYocto(pack.max_cost_near), text });
      const after = await chain.getJob(job.id);
      Object.assign(e, { status: 'delivered', deliverable_hash: hash, review_deadline_ns: after?.review_deadline_ns ?? null });
      delete e.last_error;
      delete e.pending_text;
      report.delivered.push(job.id);
    } catch (err) {
      const msg = short(err);
      if (isTransient(err)) {
        // The send may or may not have landed. Keep the text, do not count an attempt; the next pass
        // reconciles with the chain before sending anything again.
        Object.assign(e, { status: 'failed', last_error: msg });
        report.failed.push({ id: job.id, step: 'submit', reason: msg, transient: true });
      } else {
        Object.assign(e, /Job is not open/.test(msg) ? { status: 'closed', last_error: msg } : { status: 'failed', last_error: msg });
        if (e.status === 'closed') delete e.pending_text;
        report.failed.push({ id: job.id, step: 'submit', reason: msg });
      }
    }
    save();
  }
  log(report);
  return report;
}

const round = (x) => Math.round(x * 1e6) / 1e6;
const short = (err) => String(err?.message ?? err).slice(0, 200);
