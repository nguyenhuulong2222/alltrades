// Soak monitor: every 60 s, compare the chain with the baseline and read the worker log.
// On any trip: create agent/STOP, pause autopilot on chain (owner via near-cli keychain),
// stop the worker and the client, write TRIPPED, exit 1.
//
//   node scripts/soak/monitor.mjs --until <ISO> --worker-until <ISO>
// Reads backups/soak/{baseline.json,worker.log,worker.pid,client.pid}. Never reads .env.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER, logger, nearCall, sleep, snapshot } from './common.mjs';
import { checkChain, checkWorkerReports, parseWorkerLog } from './invariants.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DIR = `${root}backups/soak/`;
const STOP = `${root}agent/STOP`;
const DRILL = `${DIR}DRILL`; // present while the client runs the planned STOP drill

const alive = (pidFile) => {
  if (!existsSync(pidFile)) return false;
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; }
};
const kill = (pidFile) => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* gone */ } };

async function trip(log, reasons) {
  log('TRIP', { reasons });
  writeFileSync(STOP, '');
  writeFileSync(`${DIR}TRIPPED`, JSON.stringify({ at: new Date().toISOString(), reasons }));
  kill(`${DIR}client.pid`);
  kill(`${DIR}worker.pid`);
  try {
    const tx = await nearCall({ method: 'set_autopilot_paused', args: { paused: true }, signer: OWNER });
    log('paused_on_chain', { tx });
  } catch (e) {
    log('pause_failed', { error: e.message });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? NaN : Date.parse(process.argv[i + 1]); };
  const until = arg('--until');
  const workerUntil = arg('--worker-until');
  if (Number.isNaN(until) || Number.isNaN(workerUntil)) { console.error('Usage: node scripts/soak/monitor.mjs --until <ISO> --worker-until <ISO>'); process.exit(2); }
  const log = logger(`${DIR}monitor.log`);
  const base = JSON.parse(readFileSync(`${DIR}baseline.json`, 'utf8'));
  const seen = new Map();
  let rpcErrors = 0;
  log('monitor_start', { until: new Date(until).toISOString() });

  while (Date.now() < until) {
    await sleep(60_000);
    if (existsSync(`${DIR}TRIPPED`)) break;
    const trips = [];
    try {
      const now = await snapshot();
      rpcErrors = 0;
      const { trips: chainTrips, escrow } = checkChain(base, now, seen, Date.now());
      trips.push(...chainTrips);
      const counts = now.jobs.reduce((m, j) => ({ ...m, [j.status]: (m[j.status] ?? 0) + 1 }), {});
      log('tick', { jobs: counts, total_revenue: now.core.total_revenue, escrow: escrow.toString(), allowance: now.allowance, delivered_today: now.autopilot.delivered_today, paused: now.autopilot.paused });
    } catch (e) {
      rpcErrors += 1;
      log('rpc_error', { error: e.message.slice(0, 160), consecutive: rpcErrors });
      if (rpcErrors >= 5) trips.push(`RPC failed ${rpcErrors} times in a row`);
    }
    const wl = existsSync(`${DIR}worker.log`) ? parseWorkerLog(readFileSync(`${DIR}worker.log`, 'utf8')) : { reports: [], other: [] };
    trips.push(...checkWorkerReports(wl.reports));
    if (wl.other.length >= 3) trips.push(`worker printed ${wl.other.length} unexpected lines (crash?)`);
    const inDrill = existsSync(DRILL);
    if (!alive(`${DIR}worker.pid`) && !inDrill && Date.now() < workerUntil - 90_000) trips.push('worker process is not running');
    if (existsSync(STOP) && !inDrill) trips.push('agent/STOP present outside the planned drill');
    if (trips.length) { await trip(log, trips); process.exit(1); }
  }
  log('monitor_end');
}
