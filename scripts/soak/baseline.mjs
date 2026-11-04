// Writes backups/soak/baseline.json (the monitor's reference) and byte-comparable v1/Remit files.
//   node scripts/soak/baseline.mjs <prefix>      e.g. pre-soak, post-soak
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { view } from '../view.mjs';
import { snapshot } from './common.mjs';

const DIR = fileURLToPath(new URL('../../backups/soak/', import.meta.url));
const prefix = process.argv[2];
if (!prefix) { console.error('Usage: node scripts/soak/baseline.mjs <prefix>'); process.exit(2); }

const snap = await snapshot();
const v1 = [];
for (let i = 0; i <= 11; i++) v1.push(await view('get_job', { job_id: i }));
const orders = [];
for (let i = 0; i <= 5; i++) orders.push(await view('get_order', { order_id: i }));
const remit = await view('get_remit_config');
writeFileSync(`${DIR}${prefix}-v1-jobs.json`, JSON.stringify(v1, null, 1));
writeFileSync(`${DIR}${prefix}-remit-orders.json`, JSON.stringify(orders, null, 1));
writeFileSync(`${DIR}${prefix}-remit-config.json`, JSON.stringify(remit, null, 1));
writeFileSync(`${DIR}${prefix}-snapshot.json`, JSON.stringify(snap, null, 1));
if (prefix === 'pre-soak') writeFileSync(`${DIR}baseline.json`, JSON.stringify(snap, null, 1));
console.log(JSON.stringify({ prefix, at: snap.at, v2_jobs: snap.jobs.map((j) => `${j.id}:${j.status}`), total_revenue: snap.core.total_revenue, allowance: snap.allowance, balances: snap.balances, paused: snap.autopilot.paused, delivered_today: snap.autopilot.delivered_today }));
