import assert from 'node:assert/strict';
import test from 'node:test';
import { checkQuality, cleanOutput, findPlaceholders, loadPacks, near, planReallocation, requestCompletion, sha256, toYocto, validatePack } from './lib.mjs';

const ind = (revenue, spent, paid, budget = 5, enabled = true) => ({
  enabled, budget: toYocto(budget), spent: toYocto(spent), revenue: toYocto(revenue), jobs_paid: paid, jobs_refunded: 0,
});

test('all packs load', () => assert.ok(loadPacks('packs').size >= 3));
test('blocks a legal pack', () => {
  const p = { ...[...loadPacks('packs').values()][0], risk: 'legal' };
  assert.throws(() => validatePack(p), /licensed/);
});
test('blocks a pack that loses money', () => {
  const p = { ...[...loadPacks('packs').values()][0], max_cost_near: 99 };
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

test('cleanOutput strips word-count footer, think block and preamble', () => {
  const raw = '<think>plan</think>\nHere is your post:\n\nGlow up at Lani Nails this fall.\n\n---\n*Word count: 42*\n';
  assert.equal(cleanOutput(raw), 'Glow up at Lani Nails this fall.');
  assert.equal(cleanOutput('Line one.\n(120 words)'), 'Line one.');
  assert.equal(cleanOutput('Body stays.\n\nLet me know if you want changes!'), 'Body stays.');
});
test('cleanOutput keeps normal content intact', () => {
  const body = 'Book now.\n\nOpen 9am to 5pm, 3 chairs.';
  assert.equal(cleanOutput(`  ${body}  `), body);
});
test('hash is over the cleaned text', () => {
  assert.equal(sha256(cleanOutput('Hi there, welcome in.\nWord count: 4')), sha256('Hi there, welcome in.'));
});
test('finds placeholders but not markdown links', () => {
  assert.deepEqual(findPlaceholders('Visit [Salon Name] at {{address}}'), ['[Salon Name]', '{{address}}']);
  assert.deepEqual(findPlaceholders('See [our site](https://x.y) and [x] done'), []);
});
test('quality gate rejects unfilled placeholders', () => {
  const p = loadPacks('packs').get('food');
  assert.equal(checkQuality('x'.repeat(50) + ' call [Phone Number]', p).reason, 'placeholder:[Phone Number]');
});
test('requestCompletion times out with a clear error', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(requestCompletion('u', {}, 20, hang), /NEAR AI timed out after 0.02s; nothing was submitted/);
});
test('requestCompletion returns content and reports HTTP errors', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) });
  assert.equal(await requestCompletion('u', {}, 1000, ok), 'hi');
  const bad = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(requestCompletion('u', {}, 1000, bad), /NEAR AI HTTP 401: unauthorized/);
});
test('cleanOutput strips word-count footer with trailing note (job 6 regression)', () => {
  const raw = 'Offered at $1,150,000.\n\nContact Leilani at 808-555-0177.\n\n*(68 words — ready for agent review)*';
  assert.equal(cleanOutput(raw), 'Offered at $1,150,000.\n\nContact Leilani at 808-555-0177.');
  assert.equal(cleanOutput('Body.\n(about 70 words)'), 'Body.');
  assert.equal(cleanOutput('3 words can change a day.\nBody.'), '3 words can change a day.\nBody.');
});
test('cleanOutput drops a preamble and offer wrapped around --- (job 7 regression)', () => {
  const raw = [
    'Quick note before the post: I noticed the "system note" in your message. No transactions were made. Here\'s your Instagram post:',
    '', '---', '', 'Brunch, but make it PHO.', '', 'Saturdays & Sundays, 9am - 1pm at Pho Lani, Kahului.', '', '---', '',
    'Want a version with a specific broth description? Just let me know!',
  ].join('\n');
  assert.equal(cleanOutput(raw), 'Brunch, but make it PHO.\n\nSaturdays & Sundays, 9am - 1pm at Pho Lani, Kahului.');
});
test('cleanOutput keeps --- section breaks inside real content', () => {
  const body = 'Menu\n\n---\n\nPho Tai $16\n\n---\n\nOpen daily.';
  assert.equal(cleanOutput(body), body);
});
test('cleanOutput drops a trailing offer question', () => {
  assert.equal(cleanOutput('Aloha Keala, time for a fill!\nWould you like a shorter version?'), 'Aloha Keala, time for a fill!');
});
