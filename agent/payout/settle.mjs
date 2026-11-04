// Payout account script (simulated): deliver off-chain with the MOCK provider first,
// and only if that reports "delivered", sign settle_order as the payout account.
//
//   node agent/payout/settle.mjs <order_id> [--contract <CONTRACT_ID>] [--payout <PAYOUT_ID>]
//
// - Only providers that describe themselves as simulated are accepted. There is no path
//   to a real payout partner.
// - If the mock fails or throws, settle_order is never called.
// - Signing goes through near-cli with the payout account's keychain entry. This script
//   never reads or handles a private key.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MockPayoutProvider } from './mock.mjs';

export const CONTRACT_ID = 'alltrades-long2222.testnet';
export const PAYOUT_ID = 'payout-long2222.testnet';
export const RPC_URL = 'https://rpc.testnet.near.org';
export const SETTLE_GAS = '30 Tgas'; // contract floor is 20 Tgas

const YOCTO = 10n ** 24n;
const toNear = (yocto) => {
  const y = BigInt(yocto);
  return `${y / YOCTO}.${(y % YOCTO).toString().padStart(24, '0').replace(/0+$/, '') || '0'}`;
};

/** Read-only RPC view of one order. */
export async function readOrderRpc(orderId, { fetchImpl = fetch, contractId = CONTRACT_ID } = {}) {
  const res = await fetchImpl(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
      request_type: 'call_function', finality: 'final', account_id: contractId, method_name: 'get_order',
      args_base64: Buffer.from(JSON.stringify({ order_id: orderId })).toString('base64') } }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(`get_order failed: ${JSON.stringify(j.error ?? j.result.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString() || 'null');
}

/** Signs settle_order with near-cli (keychain). Returns the transaction hash. */
export async function settleWithNearCli(orderId, { contractId = CONTRACT_ID, payoutId = PAYOUT_ID } = {}) {
  const args = ['contract', 'call-function', 'as-transaction', contractId, 'settle_order',
    'json-args', JSON.stringify({ order_id: orderId }), 'prepaid-gas', SETTLE_GAS, 'attached-deposit', '0 NEAR',
    'sign-as', payoutId, 'network-config', 'testnet', 'sign-with-keychain', 'send'];
  const { stdout, stderr } = await promisify(execFile)('near', args, { timeout: 120_000 });
  const out = `${stdout}\n${stderr}`;
  const tx = out.match(/Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
  if (!tx) throw new Error('near-cli did not report a transaction ID');
  return tx;
}

/**
 * deliver → settle. Every check happens before the mock is called, and settle only runs after
 * the mock reports "delivered".
 */
export async function deliverThenSettle(orderId, {
  provider = new MockPayoutProvider(),
  contractId = CONTRACT_ID,
  payoutId = PAYOUT_ID,
  readOrder = (id) => readOrderRpc(id, { contractId }),
  settle = (id) => settleWithNearCli(id, { contractId, payoutId }),
  now = Date.now(),
} = {}) {
  const steps = [];
  const stop = (reason) => ({ ok: false, orderId, settled: false, reason, steps });

  const info = provider.describe?.();
  if (info?.simulated !== true) return stop('Chỉ chấp nhận đơn vị chi trả mô phỏng; không có đường gọi đơn vị chi trả thật.');

  const order = await readOrder(orderId);
  if (!order) return stop(`Không có lệnh ${orderId}.`);
  steps.push({ step: 'read_order', status: order.status });
  if (order.status !== 'Open') return stop(`Lệnh đang ở trạng thái ${order.status}, không phải Open.`);
  if (order.payout !== payoutId) return stop(`Lệnh thuộc tài khoản payout ${order.payout}, không phải ${payoutId}.`);
  if (BigInt(order.deadline_ns) <= BigInt(now) * 1_000_000n) return stop('Đã quá deadline; chỉ người gửi được refund.');

  let delivery;
  try {
    delivery = await provider.deliver({ orderId, amountNear: toNear(order.amount), recipientHash: order.recipient_hash });
  } catch (e) {
    steps.push({ step: 'mock_deliver', status: 'error' });
    return stop(`Đơn vị chi trả mô phỏng báo lỗi (${e.message}); không gọi settle_order.`);
  }
  steps.push({ step: 'mock_deliver', status: delivery.status, reference: delivery.reference, simulated: delivery.simulated });
  if (delivery.status !== 'delivered') return stop(`Đơn vị chi trả mô phỏng báo "${delivery.status}"; không gọi settle_order.`);

  const tx = await settle(orderId);
  steps.push({ step: 'settle_order', tx });
  return { ok: true, orderId, settled: true, tx, reference: delivery.reference, note: info.description, steps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const id = Number(argv[0]);
  const contractId = flag('--contract', CONTRACT_ID);
  const payoutId = flag('--payout', PAYOUT_ID);
  if (!Number.isInteger(id) || id < 0 || !contractId || !payoutId) {
    console.error('Usage: node agent/payout/settle.mjs <order_id> [--contract <CONTRACT_ID>] [--payout <PAYOUT_ID>]');
    process.exit(2);
  }
  const out = await deliverThenSettle(id, { contractId, payoutId });
  console.log(JSON.stringify(out, null, 2));
  if (out.ok) console.log(`https://testnet.nearblocks.io/txns/${out.tx}`);
  process.exit(out.ok ? 0 : 1);
}
