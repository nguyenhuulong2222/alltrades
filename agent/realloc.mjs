// Agent-side throttle for reallocate. The contract does NOT enforce this; it only
// enforces who may call reallocate and that total budget cannot grow.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { planReallocation } from './lib.mjs';

export const REALLOC_GAP = 3;
export const DEFAULT_STATE_PATH = '.agent-state.json';

/** Jobs that reached a final state (paid or refunded) across all industries. */
export const settledJobs = (industries) =>
  industries.reduce((sum, [, i]) => sum + Number(i.jobs_paid) + Number(i.jobs_refunded), 0);

export function readMarker(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const value = JSON.parse(raw)?.lastReallocSettled;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} is corrupt: lastReallocSettled must be a non-negative integer`);
  return value;
}

export function writeMarker(path, settled) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastReallocSettled: settled, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(tmp, path); // atomic replace, so a crash never leaves a half-written marker
}

/**
 * Reallocates only when settled jobs grew by at least `gap` since the last successful reallocate.
 * - Missing marker: record the current total and skip, so a lost file never causes a burst.
 * - The marker moves only after `send` resolves without a failure status.
 * `send(plan)` must return the RPC outcome; a `status.Failure` or a throw counts as failed.
 */
export async function maybeReallocate({ industries, send, statePath = DEFAULT_STATE_PATH, gap = REALLOC_GAP, log = console.log }) {
  const settled = settledJobs(industries);
  const marker = readMarker(statePath);
  if (marker === null) {
    writeMarker(statePath, settled);
    log(`reallocate: no marker found, starting count at ${settled} settled jobs; next check at ${settled + gap}`);
    return { action: 'initialized', settled };
  }
  if (settled - marker < gap) {
    log(`reallocate: skipped, ${settled - marker} of ${gap} new settled jobs since last reallocate`);
    return { action: 'waiting', settled, marker };
  }
  const plan = planReallocation(industries);
  if (!plan) {
    log('reallocate: threshold reached but no industry qualifies to move budget');
    return { action: 'no_plan', settled, marker };
  }
  const outcome = await send(plan); // a throw propagates and leaves the marker untouched
  if (outcome?.status?.Failure) {
    throw new Error(`reallocate failed on chain, marker stays at ${marker}: ${JSON.stringify(outcome.status.Failure).slice(0, 200)}`);
  }
  writeMarker(statePath, settled);
  return { action: 'reallocated', settled, plan };
}
