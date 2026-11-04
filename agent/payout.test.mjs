import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };

const { deliverThenSettle, readOrderRpc, SETTLE_GAS } = await import('./payout/settle.mjs');
const { MockPayoutProvider } = await import('./payout/mock.mjs');

const ORDER = JSON.parse(readFileSync(new URL('./payout/fixtures/order-open.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-04T00:00:00Z');
const read = (o = ORDER) => async () => structuredClone(o);
const settleSpy = () => {
  const calls = [];
  const fn = async (id) => { calls.push(id); return 'FakeTx1111111111111111111111111111111111111'; };
  return { calls, fn };
};

test('mock delivers, then settle_order is called once', async () => {
  const s = settleSpy();
  const out = await deliverThenSettle(7, { readOrder: read(), settle: s.fn, now: NOW });
  assert.equal(out.ok, true);
  assert.deepEqual(s.calls, [7]);
  assert.deepEqual(out.steps.map((x) => x.step), ['read_order', 'mock_deliver', 'settle_order']);
  assert.equal(out.steps[1].simulated, true);
  assert.match(out.note, /Mô phỏng/);
});
test('mock reports failure: settle_order is not called', async () => {
  const s = settleSpy();
  const out = await deliverThenSettle(7, { provider: new MockPayoutProvider({ failOrderIds: [7] }), readOrder: read(), settle: s.fn, now: NOW });
  assert.equal(out.ok, false);
  assert.deepEqual(s.calls, []);
  assert.match(out.reason, /báo "failed"; không gọi settle_order/);
});
test('mock throws: settle_order is not called', async () => {
  const s = settleSpy();
  const bad = new MockPayoutProvider();
  bad.deliver = async () => { throw new Error('mock outage'); };
  const out = await deliverThenSettle(7, { provider: bad, readOrder: read(), settle: s.fn, now: NOW });
  assert.equal(out.ok, false);
  assert.deepEqual(s.calls, []);
  assert.match(out.reason, /mock outage/);
});
test('a provider that is not simulated is refused before anything happens', async () => {
  const s = settleSpy();
  let read_called = false;
  const real = { describe: () => ({ name: 'RealBank', simulated: false }), deliver: async () => ({ status: 'delivered' }) };
  const out = await deliverThenSettle(7, { provider: real, readOrder: async () => { read_called = true; return ORDER; }, settle: s.fn, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(read_called, false);
  assert.deepEqual(s.calls, []);
  assert.match(out.reason, /không có đường gọi đơn vị chi trả thật/);
});
for (const [label, patch, re] of [
  ['already settled', { status: 'Settled' }, /Settled/],
  ['transfer in progress', { status: 'Settling' }, /Settling/],
  ['another payout account', { payout: 'someone-else.testnet' }, /someone-else/],
  ['past deadline', { deadline_ns: String(BigInt(NOW) * 1_000_000n) }, /quá deadline/],
]) {
  test(`no delivery and no settle when the order is ${label}`, async () => {
    const s = settleSpy();
    const provider = new MockPayoutProvider();
    let delivered = false;
    const orig = provider.deliver.bind(provider);
    provider.deliver = async (o) => { delivered = true; return orig(o); };
    const out = await deliverThenSettle(7, { provider, readOrder: read({ ...ORDER, ...patch }), settle: s.fn, now: NOW });
    assert.equal(out.ok, false);
    assert.equal(delivered, false);
    assert.deepEqual(s.calls, []);
    assert.match(out.reason, re);
  });
}
test('missing order is reported', async () => {
  const out = await deliverThenSettle(99, { readOrder: async () => null, settle: settleSpy().fn, now: NOW });
  assert.match(out.reason, /Không có lệnh 99/);
});
test('settle uses at least the 20 Tgas contract floor', () => {
  assert.ok(Number.parseFloat(SETTLE_GAS) >= 20);
});
test('readOrderRpc parses a view result from a fixture fetch', async () => {
  const body = { result: { result: [...Buffer.from(JSON.stringify(ORDER))] } };
  const o = await readOrderRpc(7, { fetchImpl: async () => ({ json: async () => body }) });
  assert.equal(o.status, 'Open');
});
test('payout script has no real partner, key or env access', () => {
  for (const f of ['agent/payout/settle.mjs', 'agent/payout/mock.mjs', 'agent/payout/provider.mjs']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/process\.env|PRIVATE_KEY|near-api-js|https:\/\/(?!rpc\.testnet\.near\.org|testnet\.nearblocks\.io)/.test(src), `${f}`);
  }
});
