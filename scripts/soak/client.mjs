// Simulated client for the soak run: creates jobs on a schedule and runs the planned scenarios
// (one dispute that the owner rules for the worker, one cancel before delivery during a 5-minute
// agent/STOP drill, then a worker restart). Signs with near-cli keychain (client, owner).
//
//   node scripts/soak/client.mjs --start <epoch-ms> --worker-until <ISO>
// Never reads .env. The restarted worker loads .env itself, exactly like the first one.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBriefs } from '../../agent/autopilot/briefs.mjs';
import { loadPacks } from '../../agent/lib.mjs';
import { view } from '../view.mjs';
import { CLIENT, OWNER, logger, nearCall, sendVerified, sleep } from './common.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DIR = `${root}backups/soak/`;
const STOP = `${root}agent/STOP`;
const MIN = 60_000;

/** The run plan, in minutes from the start. Pure data so it can be tested. */
export const PLAN = [
  { at: 0.5, brief: 'lani-nails-fall', deposit: '0.2 NEAR' },
  { at: 20, brief: 'kapalua-condo-listing', deposit: '0.25 NEAR', dispute: true },
  { at: 40, brief: 'makai-fit-class', deposit: '0.15 NEAR' },
  { at: 60, brief: 'pho-lani-review', deposit: '0.15 NEAR', cancelDuringStop: true },
  { at: 80, brief: 'lani-nails-fall', deposit: '0.2 NEAR' },
  { at: 100, brief: 'pho-lani-review', deposit: '0.15 NEAR' },
];

const tripped = () => existsSync(`${DIR}TRIPPED`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(fn, timeoutMs, everyMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    if (tripped()) return null;
    await sleep(everyMs);
  }
  return null;
}

function startWorker(until) {
  const out = openSync(`${DIR}worker.log`, 'a');
  const child = spawn('node', ['--env-file=.env', 'agent/worker.mjs', '--loop', '--interval', '60', '--until', until], {
    cwd: root, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, WORKER_MAX_JOBS_PER_RUN: '1', WORKER_MAX_COST_NEAR_PER_DAY: '0.5' },
  });
  child.unref();
  writeFileSync(`${DIR}worker.pid`, String(child.pid));
  return child.pid;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
  const start = Number(arg('--start'));
  const workerUntil = arg('--worker-until');
  const log = logger(`${DIR}client.log`);
  const briefs = loadBriefs(`${root}briefs`, { industries: new Set(loadPacks(`${root}packs`).keys()) });
  log('client_start', { start: new Date(start).toISOString(), jobs: PLAN.length });

  for (const step of PLAN) {
    const due = start + step.at * MIN;
    while (Date.now() < due) { if (tripped()) process.exit(1); await sleep(Math.min(15_000, due - Date.now())); }
    if (tripped()) process.exit(1);
    const b = briefs.get(step.brief);
    const job = (id) => view('get_job_v2', { job_id: id });
    // A retried create must not open a second job: verify by next_job_id and the job's fields.
    const create = async () => {
      const before = Number((await view('get_autopilot')).next_job_id);
      const tx = await sendVerified('create_job_v2',
        () => nearCall({ method: 'create_job_v2', args: { industry: b.industry, brief_id: b.id, brief_hash: b.hash }, signer: CLIENT, deposit: step.deposit }),
        async () => { const j = await job(before).catch(() => null); return j && j.client === CLIENT && j.brief_id === b.id; },
        { log });
      return { id: before, tx };
    };
    const write = (label, args, signer, landed) => sendVerified(label,
      () => nearCall({ method: label, args, signer }),
      async () => landed((await job(args.job_id)).status), { log });

    try {
      if (step.cancelDuringStop) {
        // STOP drill: worker must stop; a job created now must never be delivered; client cancels it.
        writeFileSync(`${DIR}DRILL`, '');
        writeFileSync(STOP, '');
        const pid = Number(readFileSync(`${DIR}worker.pid`, 'utf8'));
        log('stop_drill_begin', { worker_pid: pid });
        const exited = await waitFor(async () => !alive(pid), 4 * MIN, 5_000);
        log('worker_stopped', { exited: Boolean(exited) });
        const { id, tx } = await create();
        log('job_created', { id, brief: b.id, deposit: step.deposit, tx, note: 'created while STOP is present' });
        const ctx = await write('cancel_job_v2', { job_id: id }, CLIENT, (st) => st === 'Cancelling' || st === 'Cancelled');
        log('cancel_sent', { id, tx: ctx });
        const done = await waitFor(async () => (await job(id)).status === 'Cancelled', 2 * MIN, 10_000);
        log('cancel_result', { id, cancelled: Boolean(done) });
        await waitFor(async () => Date.now() >= due + 5 * MIN, 6 * MIN, 10_000);
        const j = await job(id);
        log('stop_drill_end', { id, status: j.status, deliverable_hash: j.deliverable_hash });
        unlinkSync(STOP);
        const newPid = startWorker(workerUntil);
        unlinkSync(`${DIR}DRILL`);
        log('worker_restarted', { pid: newPid });
        continue;
      }

      const { id, tx } = await create();
      log('job_created', { id, brief: b.id, deposit: step.deposit, tx });

      if (step.dispute) {
        const delivered = await waitFor(async () => {
          const j = await job(id);
          return j.status === 'Delivered' ? j : null;
        }, 8 * MIN);
        if (!delivered) { log('dispute_skipped', { id, reason: 'not delivered within 8 minutes' }); continue; }
        const dtx = await write('dispute_job_v2', { job_id: id }, CLIENT, (st) => st === 'Disputed' || st === 'Paid');
        log('dispute_sent', { id, tx: dtx });
        const rtx = await write('resolve_dispute_v2', { job_id: id, refund: false }, OWNER, (st) => st === 'Paid');
        const j = await job(id);
        log('dispute_resolved', { id, tx: rtx, ruling: 'worker wins', status: j.status });
      }
    } catch (e) {
      log('client_error', { step: step.brief, error: e.message.slice(0, 200) });
    }
  }
  log('client_end');
}
