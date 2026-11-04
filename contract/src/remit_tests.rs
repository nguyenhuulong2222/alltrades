use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H2: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const T0: u64 = 1_000_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
const TTL: u32 = 3600;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn n(x: u128) -> NearToken {
    NearToken::from_millinear(x)
}
const CONTRACT: &str = "alltrades.testnet";

fn at(who: &str, deposit: NearToken, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .block_timestamp(ts)
        .build());
}
/// Runs `on_order_transfer` as `caller` with the given transfer outcome.
fn callback(c: &mut Contract, caller: &str, id: u64, ok: bool) -> OrderStatus {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(caller))
            .block_timestamp(T0)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    c.on_order_transfer(id)
}
fn status(c: &Contract, id: u64) -> OrderStatus {
    c.get_order(id).unwrap().status
}
fn base() -> Contract {
    at("owner.testnet", n(0), T0);
    let mut c = Contract::init(acc("owner.testnet"), acc("agent.testnet"), n(100));
    c.add_industry("beauty".into(), n(500));
    c
}
fn setup() -> Contract {
    let mut c = base();
    c.set_remit_config(acc("payout.testnet"), n(500));
    c
}
fn order(c: &mut Contract, amount: u128) -> u64 {
    at("sender.testnet", n(amount), T0);
    c.create_order(H.into(), TTL)
}
fn deadline() -> u64 {
    T0 + u64::from(TTL) * SEC
}

// ---------- create_order ----------

#[test]
fn create_stores_hash_amount_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    let o = c.get_order(id).unwrap();
    assert_eq!(id, 0);
    assert_eq!(o.sender, acc("sender.testnet"));
    assert_eq!(o.payout, acc("payout.testnet"));
    assert_eq!(o.recipient_hash, H);
    assert_eq!(o.amount, n(200));
    assert_eq!(o.deadline_ns.0, deadline());
    assert_eq!(o.status, OrderStatus::Open);
    assert_eq!(order(&mut c, 10), 1);
}

#[test]
#[should_panic(expected = "Remit is not configured")]
fn create_rejected_before_config() {
    let mut c = base();
    order(&mut c, 100);
}

#[test]
#[should_panic(expected = "Attach a deposit to create an order")]
fn create_rejects_zero_deposit() {
    let mut c = setup();
    order(&mut c, 0);
}

#[test]
#[should_panic(expected = "Amount is below the 0.01 NEAR minimum")]
fn min_rejects_0_009999_near() {
    let mut c = setup();
    at("sender.testnet", NearToken::from_yoctonear(9_999_000_000_000_000_000_000), T0);
    c.create_order(H.into(), TTL);
}

#[test]
fn min_accepts_exactly_0_01_near() {
    let mut c = setup();
    at("sender.testnet", NearToken::from_yoctonear(10_000_000_000_000_000_000_000), T0);
    let id = c.create_order(H.into(), TTL);
    assert_eq!(c.get_order(id).unwrap().amount, MIN_ORDER_AMOUNT);
}

#[test]
fn cap_allows_exact_limit() {
    let mut c = setup();
    let id = order(&mut c, 500);
    assert_eq!(c.get_order(id).unwrap().amount, n(500));
}

#[test]
#[should_panic(expected = "Amount exceeds the per-order limit")]
fn cap_rejects_above_limit() {
    let mut c = setup();
    order(&mut c, 501);
}

#[test]
#[should_panic(expected = "recipient_hash must be 64 lowercase hex characters")]
fn create_rejects_plain_name() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order("Nguyen Van A".into(), TTL);
}

#[test]
#[should_panic(expected = "recipient_hash must be 64 lowercase hex characters")]
fn create_rejects_phone_number() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order("+84 912 345 678".into(), TTL);
}

#[test]
#[should_panic(expected = "recipient_hash must be 64 lowercase hex characters")]
fn create_rejects_bank_details() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order("Vietcombank 0011001234567 NGUYEN VAN A pad pad pad pad pad pad".into(), TTL);
}

#[test]
#[should_panic(expected = "recipient_hash must be 64 lowercase hex characters")]
fn create_rejects_uppercase_hash() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order(H.to_uppercase(), TTL);
}

#[test]
#[should_panic(expected = "ttl_secs must be between 60 and 604800")]
fn create_rejects_short_ttl() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order(H.into(), 59);
}

#[test]
#[should_panic(expected = "ttl_secs must be between 60 and 604800")]
fn create_rejects_long_ttl() {
    let mut c = setup();
    at("sender.testnet", n(10), T0);
    c.create_order(H.into(), MAX_TTL_SECS + 1);
}

#[test]
#[should_panic(expected = "Payout account cannot create orders")]
fn payout_cannot_create_orders() {
    let mut c = setup();
    at("payout.testnet", n(10), T0);
    c.create_order(H.into(), TTL);
}

// ---------- owner config ----------

#[test]
#[should_panic(expected = "Owner only")]
fn agent_cannot_set_cap() {
    let mut c = setup();
    at("agent.testnet", n(0), T0);
    c.set_remit_config(acc("payout.testnet"), n(9999));
}

#[test]
#[should_panic(expected = "Owner only")]
fn sender_cannot_set_cap() {
    let mut c = setup();
    at("sender.testnet", n(0), T0);
    c.set_remit_config(acc("sender.testnet"), n(9999));
}

#[test]
#[should_panic(expected = "Payout account cannot be the agent")]
fn agent_cannot_be_payout() {
    let mut c = base();
    c.set_remit_config(acc("agent.testnet"), n(100));
}

#[test]
#[should_panic(expected = "Payout account cannot be the owner")]
fn owner_cannot_be_payout() {
    let mut c = base();
    c.set_remit_config(acc("owner.testnet"), n(100));
}

#[test]
#[should_panic(expected = "Order limit must be at least 0.01 NEAR")]
fn cap_cannot_be_zero() {
    let mut c = base();
    c.set_remit_config(acc("payout.testnet"), n(0));
}

#[test]
#[should_panic(expected = "Order limit must be at least 0.01 NEAR")]
fn cap_cannot_be_below_minimum() {
    let mut c = base();
    c.set_remit_config(acc("payout.testnet"), n(9));
}

#[test]
fn lowering_cap_keeps_order_ids_and_old_orders() {
    let mut c = setup();
    let id = order(&mut c, 400);
    at("owner.testnet", n(0), T0);
    c.set_remit_config(acc("payout.testnet"), n(100));
    assert_eq!(c.get_order(id).unwrap().amount, n(400));
    assert_eq!(c.get_remit_config().unwrap().next_order_id, 1);
}

// ---------- settle_order ----------

#[test]
fn payout_settles_before_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline() - 1);
    let _ = c.settle_order(id);
    assert_eq!(status(&c, id), OrderStatus::Settling);
    assert_eq!(callback(&mut c, CONTRACT, id, true), OrderStatus::Settled);
    let o = c.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Settled);
    assert_eq!(o.recipient_hash, H);
    assert_eq!(o.amount, n(200));
}

#[test]
#[should_panic(expected = "Only the payout account can settle")]
fn sender_cannot_settle() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Only the payout account can settle")]
fn owner_cannot_settle() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("owner.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Order deadline has passed")]
fn cannot_settle_at_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline());
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Order has a transfer in progress")]
fn cannot_settle_twice_while_pending() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Order is not open")]
fn cannot_settle_twice_after_success() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, true);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Order is not open")]
fn cannot_settle_after_refund() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    callback(&mut c, CONTRACT, id, true);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Order has a transfer in progress")]
fn cannot_settle_while_refund_pending() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Unknown order")]
fn cannot_settle_unknown_order() {
    let mut c = setup();
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(7);
}

#[test]
#[should_panic(expected = "Only the payout account can settle")]
fn new_payout_cannot_settle_old_order() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("owner.testnet", n(0), T0);
    c.set_remit_config(acc("payout2.testnet"), n(500));
    at("payout2.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

// ---------- refund_order ----------

#[test]
fn sender_refunds_after_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    assert_eq!(status(&c, id), OrderStatus::Refunding);
    assert_eq!(callback(&mut c, CONTRACT, id, true), OrderStatus::Refunded);
    let o = c.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Refunded);
    assert_eq!(o.recipient_hash, H);
}

#[test]
#[should_panic(expected = "Deadline has not passed")]
fn cannot_refund_before_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline() - 1);
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Only the sender can refund")]
fn payout_cannot_refund() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline());
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Only the sender can refund")]
fn owner_cannot_refund() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("owner.testnet", n(0), deadline());
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Order has a transfer in progress")]
fn cannot_refund_twice_while_pending() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Order is already refunded")]
fn cannot_refund_twice_after_success() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    callback(&mut c, CONTRACT, id, true);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Order is already settled")]
fn cannot_refund_after_settle() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, true);
    at("sender.testnet", n(0), deadline() + 10 * SEC);
    let _ = c.refund_order(id);
}

#[test]
#[should_panic(expected = "Order has a transfer in progress")]
fn cannot_refund_while_settle_pending() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline() - 1);
    let _ = c.settle_order(id);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
}

// ---------- transfer callback ----------

#[test]
fn failed_settle_returns_order_to_open_and_can_retry() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    assert_eq!(callback(&mut c, CONTRACT, id, false), OrderStatus::Open);
    let o = c.get_order(id).unwrap();
    assert_eq!((o.amount, o.recipient_hash.as_str()), (n(200), H));
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    assert_eq!(callback(&mut c, CONTRACT, id, true), OrderStatus::Settled);
}

#[test]
fn failed_settle_after_deadline_lets_sender_refund() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline() - 1);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, false);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    assert_eq!(callback(&mut c, CONTRACT, id, true), OrderStatus::Refunded);
}

#[test]
fn failed_refund_returns_order_to_open_and_can_retry() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    assert_eq!(callback(&mut c, CONTRACT, id, false), OrderStatus::Open);
    assert_eq!(c.get_order(id).unwrap().amount, n(200));
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    assert_eq!(callback(&mut c, CONTRACT, id, true), OrderStatus::Refunded);
}

#[test]
#[should_panic(expected = "Order deadline has passed")]
fn failed_settle_does_not_extend_deadline() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), deadline() - 1);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, false);
    at("payout.testnet", n(0), deadline());
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Only the contract can finish a transfer")]
fn sender_cannot_call_callback() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("sender.testnet", n(0), deadline());
    let _ = c.refund_order(id);
    callback(&mut c, "sender.testnet", id, true);
}

#[test]
#[should_panic(expected = "Only the contract can finish a transfer")]
fn payout_cannot_call_callback() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, "payout.testnet", id, true);
}

#[test]
#[should_panic(expected = "Only the contract can finish a transfer")]
fn agent_cannot_call_callback() {
    let mut c = setup();
    let id = order(&mut c, 200);
    callback(&mut c, "agent.testnet", id, true);
}

#[test]
#[should_panic(expected = "Order has no transfer in progress")]
fn callback_on_open_order_is_rejected() {
    let mut c = setup();
    let id = order(&mut c, 200);
    callback(&mut c, CONTRACT, id, true);
}

#[test]
#[should_panic(expected = "Order has no transfer in progress")]
fn duplicate_callback_is_rejected() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, true);
    callback(&mut c, CONTRACT, id, true);
}

#[test]
#[should_panic(expected = "Amount exceeds earned revenue")]
fn failed_transfer_does_not_create_revenue() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, false);
    at("owner.testnet", n(0), T0);
    let _ = c.withdraw_revenue(n(1));
}

// ---------- agent is locked out ----------

#[test]
#[should_panic(expected = "Agent cannot use remit orders")]
fn agent_cannot_create_order() {
    let mut c = setup();
    at("agent.testnet", n(10), T0);
    c.create_order(H.into(), TTL);
}

#[test]
#[should_panic(expected = "Agent cannot use remit orders")]
fn agent_cannot_settle_order() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("agent.testnet", n(0), T0);
    let _ = c.settle_order(id);
}

#[test]
#[should_panic(expected = "Agent cannot use remit orders")]
fn agent_cannot_refund_order() {
    let mut c = setup();
    let id = order(&mut c, 200);
    at("agent.testnet", n(0), deadline());
    let _ = c.refund_order(id);
}

// ---------- order money is not revenue ----------

#[test]
#[should_panic(expected = "Amount exceeds earned revenue")]
fn owner_cannot_withdraw_order_money() {
    let mut c = setup();
    order(&mut c, 500);
    at("owner.testnet", n(0), T0);
    let _ = c.withdraw_revenue(n(1));
}

#[test]
#[should_panic(expected = "Amount exceeds earned revenue")]
fn order_money_not_added_to_revenue() {
    let mut c = setup();
    // Earn 100 of real revenue from a job.
    at("client.testnet", n(100), T0);
    let job = c.create_job("beauty".into());
    at("agent.testnet", n(0), T0);
    c.submit_delivery(job, H.into(), n(10));
    at("client.testnet", n(0), T0);
    c.approve_job(job);
    // Lock 300 in an order and settle it.
    let id = order(&mut c, 300);
    at("payout.testnet", n(0), T0);
    let _ = c.settle_order(id);
    callback(&mut c, CONTRACT, id, true);
    let beauty = c.get_industries().into_iter().find(|(k, _)| k == "beauty").unwrap().1;
    assert_eq!(beauty.revenue, n(100));
    // Revenue is still 100: withdrawing 101 must fail.
    at("owner.testnet", n(0), T0);
    let _ = c.withdraw_revenue(n(101));
}

#[test]
fn owner_still_withdraws_job_revenue_with_open_orders() {
    let mut c = setup();
    at("client.testnet", n(100), T0);
    let job = c.create_job("beauty".into());
    at("agent.testnet", n(0), T0);
    c.submit_delivery(job, H.into(), n(10));
    at("client.testnet", n(0), T0);
    c.approve_job(job);
    order(&mut c, 300);
    at("owner.testnet", n(0), T0);
    let _ = c.withdraw_revenue(n(100));
}

// ---------- recipient_hash is immutable, no personal data ----------

#[test]
fn no_code_path_reassigns_recipient_hash() {
    for src in [include_str!("lib.rs"), include_str!("remit.rs")] {
        assert!(!src.contains("recipient_hash ="), "recipient_hash must never be reassigned");
        assert!(!src.contains("recipient_hash.push"), "recipient_hash must never be mutated");
    }
}

#[test]
fn remit_public_methods_are_exactly_these() {
    let src = include_str!("remit.rs");
    let methods: Vec<&str> = src
        .lines()
        .filter_map(|l| l.trim().strip_prefix("pub fn "))
        .map(|l| l.split('(').next().unwrap())
        .collect();
    assert_eq!(
        methods,
        [
            "set_remit_config",
            "create_order",
            "refund_order",
            "settle_order",
            "on_order_transfer",
            "get_order",
            "get_remit_config"
        ]
    );
}

#[test]
fn second_order_keeps_its_own_hash() {
    let mut c = setup();
    let a = order(&mut c, 10);
    at("sender.testnet", n(10), T0);
    let b = c.create_order(H2.into(), TTL);
    assert_eq!(c.get_order(a).unwrap().recipient_hash, H);
    assert_eq!(c.get_order(b).unwrap().recipient_hash, H2);
}

#[test]
fn get_order_exposes_only_known_fields() {
    let mut c = setup();
    let id = order(&mut c, 10);
    let json = near_sdk::serde_json::to_value(c.get_order(id).unwrap()).unwrap();
    let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["amount", "deadline_ns", "id", "payout", "recipient_hash", "sender", "status"]);
}

#[test]
fn unknown_order_view_is_none() {
    let c = setup();
    assert!(c.get_order(0).is_none());
}

// ---------- jobs are unaffected ----------

#[test]
fn jobs_and_orders_have_separate_ids() {
    let mut c = setup();
    let o = order(&mut c, 10);
    at("client.testnet", n(100), T0);
    let j = c.create_job("beauty".into());
    assert_eq!((o, j), (0, 0));
    assert!(c.get_job(j).is_some());
    assert!(c.get_order(o).is_some());
}
