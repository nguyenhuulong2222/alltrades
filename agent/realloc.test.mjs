import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { toYocto } from './lib.mjs';
import { maybeReallocate, readMarker, settledJobs, writeMarker } from './realloc.mjs';

const ind = (revenue, spent, paid, refunded = 0) => ({
  enabled: true, budget: toYocto(0.5), spent: toYocto(spent), revenue: toYocto(revenue), jobs_paid: paid, jobs_refunded: refunded,
});
// beauty wins, food loses: a plan exists. 6 settled jobs.
const world = (extraPaid = 0) => [['beauty', ind(0.6, 0.06, 3 + extraPaid)], ['food', ind(0, 0.09, 0, 3)]];
const tmpState = () => join(mkdtempSync(join(tmpdir(), 'alltrades-')), '.agent-state.json');
const quiet = () => {};
const okSend = (calls) => async (plan) => { calls.push(plan); return { status: { SuccessValue: '' } }; };

test('settledJobs sums paid and refunded', () => assert.equal(settledJobs(world()), 6));

test('missing marker file: records current total, does not reallocate', async () => {
  const path = tmpState();
  const calls = [];
  const r = await maybeReallocate({ industries: world(), send: okSend(calls), statePath: path, log: quiet });
  assert.equal(r.action, 'initialized');
  assert.equal(calls.length, 0);
  assert.equal(readMarker(path), 6);
});

test('reallocates once total grows by 3, then a rerun with the same total does nothing', async () => {
  const path = tmpState();
  writeMarker(path, 6);
  const calls = [];
  const first = await maybeReallocate({ industries: world(3), send: okSend(calls), statePath: path, log: quiet });
  assert.equal(first.action, 'reallocated');
  assert.equal(readMarker(path), 9);
  const rerun = await maybeReallocate({ industries: world(3), send: okSend(calls), statePath: path, log: quiet });
  assert.equal(rerun.action, 'waiting');
  assert.equal(calls.length, 1);
  assert.equal(readMarker(path), 9);
});

test('growth of 2 is not enough (no modulo: 6 -> 8 waits, 6 -> 9 runs)', async () => {
  const path = tmpState();
  writeMarker(path, 6);
  const calls = [];
  assert.equal((await maybeReallocate({ industries: world(2), send: okSend(calls), statePath: path, log: quiet })).action, 'waiting');
  assert.equal(calls.length, 0);
});

test('failed transaction (thrown) keeps the marker', async () => {
  const path = tmpState();
  writeMarker(path, 6);
  const send = async () => { throw new Error('RPC timeout'); };
  await assert.rejects(maybeReallocate({ industries: world(3), send, statePath: path, log: quiet }), /RPC timeout/);
  assert.equal(readMarker(path), 6);
});

test('failed transaction (Failure status) keeps the marker', async () => {
  const path = tmpState();
  writeMarker(path, 6);
  const send = async () => ({ status: { Failure: { ActionError: { kind: 'Not enough unspent budget' } } } });
  await assert.rejects(maybeReallocate({ industries: world(3), send, statePath: path, log: quiet }), /marker stays at 6/);
  assert.equal(readMarker(path), 6);
});

test('threshold reached but no plan: no tx, marker unchanged', async () => {
  const path = tmpState();
  writeMarker(path, 0);
  const calls = [];
  const everyoneWins = [['beauty', ind(0.6, 0.06, 3)], ['food', ind(0.9, 0.09, 3)]];
  assert.equal((await maybeReallocate({ industries: everyoneWins, send: okSend(calls), statePath: path, log: quiet })).action, 'no_plan');
  assert.equal(calls.length, 0);
  assert.equal(readMarker(path), 0);
});

test('corrupt marker file is an error, not a silent reset', async () => {
  const path = tmpState();
  writeFileSync(path, '{"lastReallocSettled": "nine"}');
  await assert.rejects(maybeReallocate({ industries: world(3), send: okSend([]), statePath: path, log: quiet }), /corrupt/);
  assert.match(readFileSync(path, 'utf8'), /nine/);
  assert.equal(existsSync(path + '.tmp'), false);
});
