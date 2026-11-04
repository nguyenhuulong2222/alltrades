import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCoreState, view } from './view.mjs';

globalThis.fetch = async (url) => { throw new Error(`Network call in test: ${url}`); };

const borshString = (s) => { const b = Buffer.from(s); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u128 = (v) => Buffer.concat([u64(BigInt(v) & ((1n << 64n) - 1n)), u64(BigInt(v) >> 64n)]);

test('decodes the leading fields of the Contract STATE', () => {
  const bytes = Buffer.concat([borshString('owner.testnet'), borshString('agent.testnet'),
    u128('50000000000000000000000'), u64(11), u128('2050000000000000000000000'), u128(0), Buffer.from([1, 2, 3])]);
  assert.deepEqual(decodeCoreState(bytes), {
    owner: 'owner.testnet', agent: 'agent.testnet', max_job_cost: '50000000000000000000000',
    next_job_id: '11', total_revenue: '2050000000000000000000000', withdrawn: '0',
  });
});
test('view sends a read-only call_function query and returns only the JSON result', async () => {
  let sent;
  const fake = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { json: async () => ({ result: { result: [...Buffer.from('{"a":1}')] } }) }; };
  assert.deepEqual(await view('get_x', { id: 1 }, { contract: 'c.testnet', fetchImpl: fake }), { a: 1 });
  assert.equal(sent.url, 'https://rpc.testnet.near.org');
  assert.equal(sent.body.method, 'query');
  assert.equal(sent.body.params.request_type, 'call_function');
  assert.equal(sent.body.params.finality, 'final');
  assert.equal(Buffer.from(sent.body.params.args_base64, 'base64').toString(), '{"id":1}');
});
test('view surfaces RPC and contract errors', async () => {
  const bad = async () => ({ json: async () => ({ result: { error: 'wasm execution failed' } }) });
  await assert.rejects(view('get_x', {}, { fetchImpl: bad }), /RPC error/);
});
