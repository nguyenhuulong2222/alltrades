import assert from 'node:assert/strict';
import test from 'node:test';
import { checkQuality, loadPacks, near, planReallocation, sha256, toYocto, validatePack } from './lib.mjs';

const ind = (revenue, spent, paid, budget = 5, enabled = true) => ({
  enabled, budget: toYocto(budget), spent: toYocto(spent), revenue: toYocto(revenue), jobs_paid: paid, jobs_refunded: 0,
});

test('all packs load', () => assert.equal(loadPacks('packs').size, 3));
test('blocks a legal pack', () => {
  const p = { ...[...loadPacks('packs').values()][0], risk: 'legal' };
  assert.throws(() => validatePack(p), /licensed/);
});
test('blocks a pack that loses money', () => {
  const p = { ...[...loadPacks('packs').values()][0], max_cost_near: 9 };
  assert.throws(() => validatePack(p), /profit/);
});
test('quality gate', () => {
  const p = loadPacks('packs').get('food');
  assert.equal(checkQuality('short', p).ok, false);
  assert.equal(checkQuality('x'.repeat(50) + ' allergen free', p).ok, false);
  assert.equal(checkQuality('x'.repeat(50), p).ok, true);
});
test('sha256 is 64 hex', () => assert.match(sha256('a'), /^[0-9a-f]{64}$/));
test('yocto round trip', () => assert.equal(near(toYocto(0.25)), 0.25));
test('moves budget from loser to winner', () => {
  const plan = planReallocation([['beauty', ind(2, 0.2, 5)], ['food', ind(0.1, 1, 3)]]);
  assert.equal(plan.from, 'food');
  assert.equal(plan.to, 'beauty');
  assert.equal(near(plan.amount), 0.8);
});
test('waits for enough jobs', () => {
  assert.equal(planReallocation([['beauty', ind(2, 0.2, 5)], ['food', ind(0, 1, 1)]]), null);
});
test('no move when nobody loses', () => {
  assert.equal(planReallocation([['beauty', ind(2, 0.2, 5)], ['food', ind(1, 0.2, 5)]]), null);
});
