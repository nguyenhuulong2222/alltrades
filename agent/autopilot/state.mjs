// Local worker state (gitignored). Written atomically before and after every step, so a
// restarted worker neither repeats paid AI work nor forgets jobs it must finalize.
// The contract is the source of truth: it rejects a second delivery or finalize anyway.

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const emptyState = () => ({ version: 1, day: null, costTodayNear: 0, jobs: {} });

export function readState(path) {
  if (!existsSync(path)) return emptyState();
  const s = JSON.parse(readFileSync(path, 'utf8')); // corrupt state is an error, not a silent reset
  if (s?.version !== 1 || typeof s.jobs !== 'object') throw new Error(`Unrecognized worker state in ${path}`);
  return s;
}

export function writeState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Single-instance lock. Returns a release function; throws if another live worker holds it. */
export function acquireLock(path, pid = process.pid) {
  if (existsSync(path)) {
    const other = Number(readFileSync(path, 'utf8'));
    let alive = false;
    try { process.kill(other, 0); alive = true; } catch { alive = false; }
    if (alive && other !== pid) throw new Error(`Another worker is running (pid ${other})`);
    unlinkSync(path);
  }
  const fd = openSync(path, 'wx');
  writeFileSync(fd, String(pid));
  closeSync(fd);
  return () => { try { unlinkSync(path); } catch { /* already gone */ } };
}
