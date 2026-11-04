// MockPayoutProvider: mô phỏng. It calls no real service, moves no money and no VND.
// It keeps results in memory only, for demos and tests.

import { PayoutProvider } from './provider.mjs';

export const MOCK_NOTE = 'Mô phỏng: không gọi dịch vụ thật, không có tiền thật hay VND thật được chuyển.';

export class MockPayoutProvider extends PayoutProvider {
  #records = new Map();
  #next = 1;

  constructor({ failOrderIds = [] } = {}) {
    super();
    this.failOrderIds = new Set(failOrderIds);
  }

  describe() {
    return { name: 'MockPayoutProvider', simulated: true, description: MOCK_NOTE };
  }

  async deliver({ orderId, amountNear, recipientHash }) {
    if (!/^[0-9a-f]{64}$/.test(recipientHash ?? '')) throw new Error('recipientHash must be 64 lowercase hex characters');
    const reference = `mock-${this.#next++}`;
    const status = this.failOrderIds.has(orderId) ? 'failed' : 'delivered';
    this.#records.set(reference, { reference, orderId, amountNear, status });
    return { reference, status, simulated: true, note: MOCK_NOTE };
  }

  async status(reference) {
    const r = this.#records.get(reference);
    return r ? { reference, status: r.status, simulated: true } : null;
  }
}
