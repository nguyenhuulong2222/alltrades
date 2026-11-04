// PayoutProvider: the off-chain partner that would deliver VND to the recipient.
// The contract only knows the payout account; this interface is what that account's
// operator would implement. A provider never sees recipient details from the chain:
// it receives an order id, the amount and the recipient_hash.

export class PayoutProvider {
  /** @returns {{ name: string, simulated: boolean, description: string }} */
  describe() {
    throw new Error('PayoutProvider.describe() not implemented');
  }

  /**
   * Delivers an order off-chain.
   * @param {{ orderId: number, amountNear: string, recipientHash: string }} order
   * @returns {Promise<{ reference: string, status: 'delivered' | 'failed', simulated: boolean, note: string }>}
   */
  async deliver(order) {
    throw new Error('PayoutProvider.deliver() not implemented');
  }

  /** @returns {Promise<{ reference: string, status: string } | null>} */
  async status(reference) {
    throw new Error('PayoutProvider.status() not implemented');
  }
}
