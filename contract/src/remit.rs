//! Remit: simulated transfer orders (testnet demo, no real money).
//!
//! A sender locks testnet NEAR in an order. Before the deadline, the simulated
//! payout account settles it and receives the NEAR. After the deadline, the
//! sender can take a refund instead. Recipient details stay off-chain; only a
//! salted SHA-256 hash is stored.
//!
//! Remit state lives under its own storage keys, so the job contract's state
//! layout is unchanged and the deployed contract needs no migration.
//! Order money never touches `total_revenue`, so `withdraw_revenue` cannot reach it.

use crate::*;
use near_sdk::borsh;
use near_sdk::json_types::U64;

const CONFIG_KEY: &[u8] = b"remit:cfg";
const ORDER_PREFIX: &[u8] = b"remit:o:";
pub const MIN_TTL_SECS: u32 = 60;
pub const MAX_TTL_SECS: u32 = 7 * 24 * 3600;

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum OrderStatus {
    Open,
    Settled,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct RemitConfig {
    /// Simulated payout partner. The only account that can settle orders created after it is set.
    pub payout: AccountId,
    /// Per-order ceiling set by the owner.
    pub max_order_amount: NearToken,
    pub next_order_id: u64,
}

/// No names, bank accounts or phone numbers: only account IDs, amounts and a hash.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct TransferOrder {
    pub id: u64,
    pub sender: AccountId,
    /// Payout account at creation time. Changing the config later does not change it.
    pub payout: AccountId,
    /// Salted SHA-256 (lowercase hex) of the recipient details, computed off-chain.
    pub recipient_hash: String,
    pub amount: NearToken,
    /// Block timestamp in nanoseconds. Settle before it, refund from it on.
    pub deadline_ns: U64,
    pub status: OrderStatus,
}

#[near]
impl Contract {
    // ---------- Owner ----------

    pub fn set_remit_config(&mut self, payout: AccountId, max_order_amount: NearToken) {
        self.assert_owner();
        require!(payout != self.agent, "Payout account cannot be the agent");
        require!(payout != self.owner, "Payout account cannot be the owner");
        require!(!max_order_amount.is_zero(), "Order limit must be above zero");
        let next_order_id = read_config().map(|c| c.next_order_id).unwrap_or(0);
        write_config(&RemitConfig { payout, max_order_amount, next_order_id });
    }

    // ---------- Sender ----------

    #[payable]
    pub fn create_order(&mut self, recipient_hash: String, ttl_secs: u32) -> u64 {
        let sender = env::predecessor_account_id();
        self.assert_not_agent(&sender);
        let mut cfg = read_config().expect("Remit is not configured");
        require!(sender != cfg.payout, "Payout account cannot create orders");

        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "Attach a deposit to create an order");
        require!(amount <= cfg.max_order_amount, "Amount exceeds the per-order limit");
        require!(is_sha256_hex(&recipient_hash), "recipient_hash must be 64 lowercase hex characters");
        require!(
            (MIN_TTL_SECS..=MAX_TTL_SECS).contains(&ttl_secs),
            "ttl_secs must be between 60 and 604800"
        );

        let id = cfg.next_order_id;
        cfg.next_order_id += 1;
        let deadline = env::block_timestamp() + u64::from(ttl_secs) * 1_000_000_000;
        write_order(&TransferOrder {
            id,
            sender,
            payout: cfg.payout.clone(),
            recipient_hash,
            amount,
            deadline_ns: U64(deadline),
            status: OrderStatus::Open,
        });
        write_config(&cfg);
        id
    }

    /// Sender takes the money back after the deadline if the order was never settled.
    pub fn refund_order(&mut self, order_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        self.assert_not_agent(&caller);
        let mut order = read_order(order_id).expect("Unknown order");
        require!(caller == order.sender, "Only the sender can refund");
        require!(order.status != OrderStatus::Settled, "Order is already settled");
        require!(order.status != OrderStatus::Refunded, "Order is already refunded");
        require!(env::block_timestamp() >= order.deadline_ns.0, "Deadline has not passed");

        order.status = OrderStatus::Refunded;
        write_order(&order);
        Promise::new(order.sender).transfer(order.amount)
    }

    // ---------- Simulated payout partner ----------

    /// Payout partner confirms delivery before the deadline and receives the locked NEAR.
    pub fn settle_order(&mut self, order_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        self.assert_not_agent(&caller);
        let mut order = read_order(order_id).expect("Unknown order");
        require!(caller == order.payout, "Only the payout account can settle");
        require!(order.status == OrderStatus::Open, "Order is not open");
        require!(env::block_timestamp() < order.deadline_ns.0, "Order deadline has passed");

        order.status = OrderStatus::Settled;
        write_order(&order);
        Promise::new(order.payout).transfer(order.amount)
    }

    // ---------- Views ----------

    pub fn get_order(&self, order_id: u64) -> Option<TransferOrder> {
        read_order(order_id)
    }

    pub fn get_remit_config(&self) -> Option<RemitConfig> {
        read_config()
    }

    // ---------- Internal ----------

    fn assert_not_agent(&self, who: &AccountId) {
        require!(*who != self.agent, "Agent cannot use remit orders");
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn order_key(id: u64) -> Vec<u8> {
    [ORDER_PREFIX, &id.to_le_bytes()].concat()
}

fn read_config() -> Option<RemitConfig> {
    env::storage_read(CONFIG_KEY).map(|b| borsh::from_slice(&b).expect("Bad remit config"))
}

fn write_config(cfg: &RemitConfig) {
    env::storage_write(CONFIG_KEY, &borsh::to_vec(cfg).unwrap());
}

fn read_order(id: u64) -> Option<TransferOrder> {
    env::storage_read(&order_key(id)).map(|b| borsh::from_slice(&b).expect("Bad order"))
}

fn write_order(order: &TransferOrder) {
    env::storage_write(&order_key(order.id), &borsh::to_vec(order).unwrap());
}
