// Read-only views of the AllTrades contract over public testnet RPC. No keys, no writes.
// Prints only the JSON result (no block info), so snapshots can be diffed byte for byte.
//
//   node scripts/view.mjs get_industries
//   node scripts/view.mjs get_job '{"job_id":3}'
//   node scripts/view.mjs --core-state            # owner, agent, max_job_cost, next_job_id, total_revenue, withdrawn
//   node scripts/view.mjs --account worker-long2222.testnet   # balance and code hash of any account
// Options: --contract <id> (default alltrades-long2222.testnet), --rpc <url> (tried first; defaults in agent/rpc.mjs)

import { DEFAULT_RPCS, rpcRequest, rpcUrls } from '../agent/rpc.mjs';

export const DEFAULT_CONTRACT = 'alltrades-long2222.testnet';
export const DEFAULT_RPC = DEFAULT_RPCS[0];

/** JSON-RPC query with backoff, jitter and failover (agent/rpc.mjs). --rpc puts one endpoint first. */
export async function query(params, { rpc, fetchImpl = fetch, onEvent } = {}) {
  const urls = rpc ? [rpc, ...DEFAULT_RPCS.filter((u) => u !== rpc)] : rpcUrls();
  try {
    return await rpcRequest('query', { finality: 'final', ...params }, { urls, fetchImpl, onEvent });
  } catch (e) {
    throw new Error(`RPC error: ${String(e.message).slice(0, 200)}`);
  }
}

export async function view(method, args = {}, { contract = DEFAULT_CONTRACT, ...opts } = {}) {
  const r = await query({ request_type: 'call_function', account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, opts);
  return JSON.parse(Buffer.from(r.result).toString() || 'null');
}

/** Decodes the borsh STATE prefix: the fields declared first in `struct Contract`. */
export function decodeCoreState(bytes) {
  const b = Buffer.from(bytes);
  let o = 0;
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString(); o += n; return s; };
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const u128 = () => { const lo = u64(), hi = u64(); return (hi << 64n) | lo; };
  return {
    owner: str(), agent: str(), max_job_cost: u128().toString(), next_job_id: u64().toString(),
    total_revenue: u128().toString(), withdrawn: u128().toString(),
  };
}

export async function coreState({ contract = DEFAULT_CONTRACT, ...opts } = {}) {
  const r = await query({ request_type: 'view_state', account_id: contract, prefix_base64: Buffer.from('STATE').toString('base64') }, opts);
  const v = r.values.find((x) => Buffer.from(x.key, 'base64').toString() === 'STATE');
  if (!v) throw new Error('No STATE key');
  return decodeCoreState(Buffer.from(v.value, 'base64'));
}

export async function account(id, opts = {}) {
  const r = await query({ request_type: 'view_account', account_id: id }, opts);
  return { account: id, amount: r.amount, locked: r.locked, code_hash: r.code_hash, storage_usage: r.storage_usage };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const take = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const opts = { contract: take('--contract') ?? DEFAULT_CONTRACT, rpc: take('--rpc') };
  const acc = take('--account');
  try {
    let out;
    if (argv.includes('--core-state')) out = await coreState(opts);
    else if (acc) out = await account(acc, opts);
    else if (argv[0]) out = await view(argv[0], argv[1] ? JSON.parse(argv[1]) : {}, opts);
    else { console.error('Usage: node scripts/view.mjs <method> [json-args] | --core-state | --account <id> [--contract id] [--rpc url]'); process.exit(2); }
    console.log(JSON.stringify(out, null, 1));
  } catch (e) {
    console.error(`ERROR ${e.message}`);
    process.exit(1);
  }
}
