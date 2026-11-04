use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const CONTRACT: &str = "alltrades.testnet";
const T0: u64 = 1_000_000_000_000_000_000; // a day boundary is not crossed until T0 + 1 day
const SEC: u64 = 1_000_000_000;
const DAY: u64 = 86_400 * SEC;
const REVIEW: u32 = 600;
const BRIEF: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const TEXT: &str = "Fall glow-up week at Lani Nails (fictional): book a gel set before Sunday.";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn n(x: u128) -> NearToken {
    NearToken::from_millinear(x)
}
fn at(who: &str, deposit: NearToken, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .block_timestamp(ts)
        .build());
}
fn at_gas(who: &str, ts: u64, gas: near_sdk::Gas) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(who))
            .block_timestamp(ts)
            .prepaid_gas(gas)
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::free(),
    );
}
fn callback(c: &mut Contract, caller: &str, id: u64, ok: bool) -> JobV2Status {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        VMContextBuilder::new().current_account_id(acc(CONTRACT)).predecessor_account_id(acc(caller)).block_timestamp(T0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    c.on_job_v2_refund(id)
}
fn rejects(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("call should fail");
    err.downcast_ref::<String>().cloned().unwrap_or_default()
}
fn base() -> Contract {
    // Fresh storage, so a test can build several contracts in a row.
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    at("owner.testnet", n(0), T0);
    let mut c = Contract::init(acc("owner.testnet"), acc("agent.testnet"), n(100));
    c.add_industry("beauty".into(), n(500));
    c.add_industry("food".into(), n(500));
    c
}
fn setup() -> Contract {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(150), 10, false);
    c
}
fn job(c: &mut Contract) -> u64 {
    at("client.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "lani-nails-fall".into(), BRIEF.into())
}
fn deliver(c: &mut Contract, id: u64, ts: u64) {
    at("worker.testnet", n(0), ts);
    c.submit_delivery_v2(id, sha256_hex(TEXT), n(20), TEXT.into());
}
fn deadline() -> u64 {
    T0 + u64::from(REVIEW) * SEC
}
fn status(c: &Contract, id: u64) -> JobV2Status {
    c.get_job_v2(id).unwrap().status
}
fn beauty(c: &Contract) -> Industry {
    c.get_industries().into_iter().find(|(k, _)| k == "beauty").unwrap().1
}
fn delivered_job(c: &mut Contract) -> u64 {
    let id = job(c);
    deliver(c, id, T0);
    id
}

// ========== 1. Config ==========

#[test]
fn owner_sets_config() {
    let c = setup();
    let cfg = c.get_autopilot().unwrap();
    assert_eq!((cfg.worker, cfg.review_window_secs, cfg.min_job_price, cfg.max_deliveries_per_day, cfg.paused),
        (acc("worker.testnet"), REVIEW, n(150), 10, false));
}
#[test]
#[should_panic(expected = "Owner only")]
fn worker_cannot_set_config() {
    let mut c = setup();
    at("worker.testnet", n(0), T0);
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(150), 10, false);
}
#[test]
#[should_panic(expected = "Worker cannot be the owner")]
fn worker_cannot_be_owner() {
    let mut c = base();
    c.set_autopilot(acc("owner.testnet"), REVIEW, n(150), 10, false);
}
#[test]
#[should_panic(expected = "Worker cannot be the v1 agent")]
fn worker_cannot_be_v1_agent() {
    let mut c = base();
    c.set_autopilot(acc("agent.testnet"), REVIEW, n(150), 10, false);
}
#[test]
#[should_panic(expected = "review_window_secs must be between 300 and 604800")]
fn review_window_too_short() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), 299, n(150), 10, false);
}
#[test]
#[should_panic(expected = "review_window_secs must be between 300 and 604800")]
fn review_window_too_long() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), MAX_REVIEW_SECS + 1, n(150), 10, false);
}
#[test]
#[should_panic(expected = "min_job_price must be above max_job_cost")]
fn min_price_must_exceed_cost_cap() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(100), 10, false);
}
#[test]
#[should_panic(expected = "max_deliveries_per_day must be between 1 and 10")]
fn daily_limit_cannot_exceed_10() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(150), 11, false);
}
#[test]
#[should_panic(expected = "max_deliveries_per_day must be between 1 and 10")]
fn daily_limit_cannot_be_zero() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(150), 0, false);
}
#[test]
fn reconfig_keeps_counters() {
    let mut c = setup();
    delivered_job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot(acc("worker2.testnet"), REVIEW, n(150), 5, false);
    let cfg = c.get_autopilot().unwrap();
    assert_eq!((cfg.next_job_id, cfg.delivered_today), (1, 1));
}
#[test]
#[should_panic(expected = "Autopilot is not configured")]
fn nothing_works_before_config() {
    let mut c = base();
    at("client.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "x".into(), BRIEF.into());
}

// ========== 2. create_job_v2 ==========

#[test]
fn create_stores_job_without_brief_text() {
    let mut c = setup();
    let id = job(&mut c);
    let j = c.get_job_v2(id).unwrap();
    assert_eq!((j.id, j.status.clone(), j.amount, j.brief_id.as_str(), j.brief_hash.as_str()), (0, JobV2Status::Open, n(200), "lani-nails-fall", BRIEF));
    assert!(j.deliverable_hash.is_none() && j.review_deadline_ns.is_none());
    let json = near_sdk::serde_json::to_value(&j).unwrap();
    let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["amount", "brief_hash", "brief_id", "client", "cost", "deliverable_hash", "delivered_at_ns", "id", "industry", "review_deadline_ns", "status"]);
}
#[test]
#[should_panic(expected = "Deposit is below min_job_price")]
fn create_rejects_low_deposit() {
    let mut c = setup();
    at("client.testnet", n(149), T0);
    c.create_job_v2("beauty".into(), "x".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "Industry is paused")]
fn create_rejects_paused_industry() {
    let mut c = setup();
    c.pause_industry("beauty".into());
    job(&mut c);
}
#[test]
#[should_panic(expected = "Unknown industry")]
fn create_rejects_unknown_industry() {
    let mut c = setup();
    at("client.testnet", n(200), T0);
    c.create_job_v2("tax".into(), "x".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "brief_hash must be 64 lowercase hex characters")]
fn create_rejects_free_text_brief() {
    let mut c = setup();
    at("client.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "x".into(), "Write a post for Jane Doe, call 808-555-0100".into());
}
#[test]
#[should_panic(expected = "brief_id must be 1-40 characters")]
fn create_rejects_bad_brief_id() {
    let mut c = setup();
    at("client.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "Jane Doe".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "Worker and agent cannot create jobs")]
fn worker_cannot_create_jobs() {
    let mut c = setup();
    at("worker.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "x".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "Worker and agent cannot create jobs")]
fn agent_cannot_create_jobs() {
    let mut c = setup();
    at("agent.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "x".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "Owner cannot be a client")]
fn owner_cannot_be_client() {
    let mut c = setup();
    at("owner.testnet", n(200), T0);
    c.create_job_v2("beauty".into(), "x".into(), BRIEF.into());
}
#[test]
#[should_panic(expected = "Autopilot is paused")]
fn create_rejected_while_paused() {
    let mut c = setup();
    c.set_autopilot_paused(true);
    job(&mut c);
}

// ========== 3. submit_delivery_v2 ==========

#[test]
fn worker_delivers_and_sets_deadline() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    let j = c.get_job_v2(id).unwrap();
    assert_eq!(j.status, JobV2Status::Delivered);
    assert_eq!(j.deliverable_hash.unwrap(), sha256_hex(TEXT));
    assert_eq!(j.review_deadline_ns.unwrap().0, deadline());
    assert_eq!(j.cost, n(20));
    assert_eq!(beauty(&c).spent, n(20));
}
#[test]
fn only_worker_delivers() {
    for who in ["agent.testnet", "client.testnet", "owner.testnet", "stranger.testnet"] {
        let mut c = setup();
        let id = job(&mut c);
        at(who, n(0), T0);
        let msg = rejects(|| c.submit_delivery_v2(id, sha256_hex(TEXT), n(20), TEXT.into()));
        assert!(msg.contains("Worker only"), "{who}: {msg}");
        assert_eq!(status(&c, id), JobV2Status::Open);
    }
}
#[test]
#[should_panic(expected = "Job is not open")]
fn cannot_deliver_twice() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    deliver(&mut c, id, T0);
}
#[test]
#[should_panic(expected = "Cost exceeds the per-job limit")]
fn cost_cap_applies() {
    let mut c = setup();
    let id = job(&mut c);
    at("worker.testnet", n(0), T0);
    c.submit_delivery_v2(id, sha256_hex(TEXT), n(101), TEXT.into());
}
#[test]
#[should_panic(expected = "Industry budget exceeded")]
fn industry_budget_applies() {
    let mut c = setup();
    c.add_industry("small".into(), n(10));
    at("client.testnet", n(200), T0);
    let id = c.create_job_v2("small".into(), "x".into(), BRIEF.into());
    deliver(&mut c, id, T0);
}
#[test]
#[should_panic(expected = "deliverable_hash does not match text")]
fn hash_must_match_text() {
    let mut c = setup();
    let id = job(&mut c);
    at("worker.testnet", n(0), T0);
    c.submit_delivery_v2(id, sha256_hex("other text"), n(20), TEXT.into());
}
#[test]
#[should_panic(expected = "Deliverable must be 1-4096 bytes")]
fn text_over_4096_bytes_rejected() {
    let mut c = setup();
    let id = job(&mut c);
    let big = "a".repeat(MAX_DELIVERABLE_BYTES + 1);
    at("worker.testnet", n(0), T0);
    c.submit_delivery_v2(id, sha256_hex(&big), n(20), big);
}
#[test]
fn text_of_exactly_4096_bytes_accepted() {
    let mut c = setup();
    let id = job(&mut c);
    let big = "a".repeat(MAX_DELIVERABLE_BYTES);
    at("worker.testnet", n(0), T0);
    c.submit_delivery_v2(id, sha256_hex(&big), n(20), big);
    assert_eq!(status(&c, id), JobV2Status::Delivered);
}
#[test]
#[should_panic(expected = "Deliverable must be 1-4096 bytes")]
fn empty_text_rejected() {
    let mut c = setup();
    let id = job(&mut c);
    at("worker.testnet", n(0), T0);
    c.submit_delivery_v2(id, sha256_hex(""), n(20), String::new());
}
#[test]
fn daily_limit_blocks_the_11th_and_resets_next_day() {
    let mut c = setup();
    let ids: Vec<u64> = (0..11).map(|_| job(&mut c)).collect();
    for &id in &ids[..10] {
        deliver(&mut c, id, T0);
    }
    at("worker.testnet", n(0), T0);
    let msg = rejects(|| c.submit_delivery_v2(ids[10], sha256_hex(TEXT), n(20), TEXT.into()));
    assert!(msg.contains("Daily delivery limit reached"), "{msg}");
    assert_eq!(status(&c, ids[10]), JobV2Status::Open);
    deliver(&mut c, ids[10], T0 + DAY);
    assert_eq!(status(&c, ids[10]), JobV2Status::Delivered);
}
#[test]
fn lower_daily_limit_is_respected() {
    let mut c = base();
    c.set_autopilot(acc("worker.testnet"), REVIEW, n(150), 2, false);
    let ids: Vec<u64> = (0..3).map(|_| job(&mut c)).collect();
    deliver(&mut c, ids[0], T0);
    deliver(&mut c, ids[1], T0);
    at("worker.testnet", n(0), T0);
    let msg = rejects(|| c.submit_delivery_v2(ids[2], sha256_hex(TEXT), n(20), TEXT.into()));
    assert!(msg.contains("Daily delivery limit reached"));
}
#[test]
#[should_panic(expected = "Autopilot is paused")]
fn delivery_rejected_while_paused() {
    let mut c = setup();
    let id = job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(true);
    deliver(&mut c, id, T0);
}
#[test]
#[should_panic(expected = "Worker only")]
fn replaced_worker_key_is_locked_out() {
    let mut c = setup();
    let id = job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_worker(acc("worker2.testnet"));
    deliver(&mut c, id, T0);
}

// ========== 4. finalize_job_v2 ==========

#[test]
fn anyone_finalizes_at_deadline_and_revenue_is_credited_once() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("stranger.testnet", n(0), deadline());
    c.finalize_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Paid);
    assert_eq!((beauty(&c).revenue, beauty(&c).jobs_paid), (n(200), 1));
    let msg = rejects(|| c.finalize_job_v2(id));
    assert!(msg.contains("Only a Delivered job can be finalized"), "{msg}");
    assert_eq!((beauty(&c).revenue, beauty(&c).jobs_paid), (n(200), 1));
}
#[test]
fn worker_can_finalize() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("worker.testnet", n(0), deadline() + SEC);
    c.finalize_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Paid);
}
#[test]
fn cannot_finalize_before_deadline() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("worker.testnet", n(0), deadline() - 1);
    let msg = rejects(|| c.finalize_job_v2(id));
    assert!(msg.contains("Review window is still open"), "{msg}");
    assert_eq!(status(&c, id), JobV2Status::Delivered);
    assert_eq!(beauty(&c).revenue, n(0));
}
#[test]
#[should_panic(expected = "Only a Delivered job can be finalized")]
fn cannot_finalize_open_job() {
    let mut c = setup();
    let id = job(&mut c);
    at("worker.testnet", n(0), deadline());
    c.finalize_job_v2(id);
}
#[test]
#[should_panic(expected = "Only a Delivered job can be finalized")]
fn cannot_finalize_disputed_job() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), T0);
    c.dispute_job_v2(id);
    at("worker.testnet", n(0), deadline());
    c.finalize_job_v2(id);
}
#[test]
#[should_panic(expected = "Autopilot is paused")]
fn cannot_finalize_while_paused() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(true);
    at("worker.testnet", n(0), deadline());
    c.finalize_job_v2(id);
}

// ========== 5. dispute_job_v2 ==========

#[test]
fn client_disputes_before_deadline() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), deadline() - 1);
    c.dispute_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Disputed);
}
#[test]
fn client_cannot_dispute_at_or_after_deadline() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), deadline());
    let msg = rejects(|| c.dispute_job_v2(id));
    assert!(msg.contains("Review window has closed"), "{msg}");
    assert_eq!(status(&c, id), JobV2Status::Delivered);
}
#[test]
fn paused_autopilot_lets_client_dispute_after_deadline() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(true);
    at("client.testnet", n(0), deadline() + DAY);
    c.dispute_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Disputed);
}
#[test]
#[should_panic(expected = "Only the client can dispute")]
fn only_client_disputes() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("stranger.testnet", n(0), T0);
    c.dispute_job_v2(id);
}
#[test]
#[should_panic(expected = "Only a Delivered job can be disputed")]
fn cannot_dispute_twice() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), T0);
    c.dispute_job_v2(id);
    c.dispute_job_v2(id);
}
#[test]
#[should_panic(expected = "Only a Delivered job can be disputed")]
fn cannot_dispute_open_job() {
    let mut c = setup();
    let id = job(&mut c);
    at("client.testnet", n(0), T0);
    c.dispute_job_v2(id);
}

// ========== 6. cancel_job_v2 and "no refund after the window" ==========

#[test]
fn client_cancels_open_job_via_callback() {
    let mut c = setup();
    let id = job(&mut c);
    at("client.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Cancelling);
    assert_eq!(callback(&mut c, CONTRACT, id, true), JobV2Status::Cancelled);
    assert_eq!(beauty(&c).jobs_refunded, 0, "a cancel before delivery is not a refund");
}
#[test]
#[should_panic(expected = "Only the client can cancel")]
fn only_client_cancels() {
    let mut c = setup();
    let id = job(&mut c);
    at("worker.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
}
#[test]
fn cannot_cancel_after_delivery() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), T0);
    let msg = rejects(|| { let _ = c.cancel_job_v2(id); });
    assert!(msg.contains("Only an Open job can be cancelled"), "{msg}");
    assert_eq!(status(&c, id), JobV2Status::Delivered);
}
#[test]
fn client_has_no_refund_path_after_the_window() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("client.testnet", n(0), deadline());
    assert!(rejects(|| { let _ = c.cancel_job_v2(id); }).contains("Only an Open job can be cancelled"));
    assert!(rejects(|| c.dispute_job_v2(id)).contains("Review window has closed"));
    // v1 refund does not reach v2 jobs: id 0 is not a v1 job.
    assert!(rejects(|| { let _ = c.refund_job(id); }).contains("Unknown job"));
    at("anyone.testnet", n(0), deadline());
    c.finalize_job_v2(id);
    at("client.testnet", n(0), deadline());
    assert!(rejects(|| { let _ = c.cancel_job_v2(id); }).contains("Only an Open job can be cancelled"));
    assert!(rejects(|| c.dispute_job_v2(id)).contains("Only a Delivered job can be disputed"));
    assert_eq!(status(&c, id), JobV2Status::Paid);
}
#[test]
fn cancel_allowed_while_paused() {
    let mut c = setup();
    let id = job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(true);
    at("client.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Cancelling);
}

// ========== 7. resolve_dispute_v2 ==========

fn disputed(c: &mut Contract) -> u64 {
    let id = delivered_job(c);
    at("client.testnet", n(0), T0);
    c.dispute_job_v2(id);
    id
}
#[test]
fn owner_rules_for_worker_and_job_is_paid() {
    let mut c = setup();
    let id = disputed(&mut c);
    at("owner.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, false);
    assert_eq!(status(&c, id), JobV2Status::Paid);
    assert_eq!((beauty(&c).revenue, beauty(&c).jobs_paid), (n(200), 1));
}
#[test]
fn owner_rules_refund_via_callback() {
    let mut c = setup();
    let id = disputed(&mut c);
    at("owner.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, true);
    assert_eq!(status(&c, id), JobV2Status::Refunding);
    assert_eq!(callback(&mut c, CONTRACT, id, true), JobV2Status::Refunded);
    assert_eq!((beauty(&c).revenue, beauty(&c).jobs_refunded), (n(0), 1));
    assert_eq!(beauty(&c).spent, n(20), "the delivery cost stays spent");
}
#[test]
#[should_panic(expected = "Owner only")]
fn client_cannot_resolve() {
    let mut c = setup();
    let id = disputed(&mut c);
    at("client.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, true);
}
#[test]
#[should_panic(expected = "Owner only")]
fn worker_cannot_resolve() {
    let mut c = setup();
    let id = disputed(&mut c);
    at("worker.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, false);
}
#[test]
#[should_panic(expected = "Only a Disputed job can be resolved")]
fn cannot_resolve_undisputed_job() {
    let mut c = setup();
    let id = delivered_job(&mut c);
    at("owner.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, true);
}

// ========== 8. Callback ==========

#[test]
fn failed_cancel_refund_returns_job_to_open() {
    let mut c = setup();
    let id = job(&mut c);
    at("client.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
    assert_eq!(callback(&mut c, CONTRACT, id, false), JobV2Status::Open);
    assert_eq!(c.get_job_v2(id).unwrap().amount, n(200));
}
#[test]
fn failed_dispute_refund_returns_job_to_disputed() {
    let mut c = setup();
    let id = disputed(&mut c);
    at("owner.testnet", n(0), T0);
    let _ = c.resolve_dispute_v2(id, true);
    assert_eq!(callback(&mut c, CONTRACT, id, false), JobV2Status::Disputed);
    assert_eq!(beauty(&c).jobs_refunded, 0);
}
#[test]
fn outsiders_cannot_call_the_callback() {
    for who in ["client.testnet", "worker.testnet", "owner.testnet", "agent.testnet"] {
        let mut c = setup();
        let id = job(&mut c);
        at("client.testnet", n(0), T0);
        let _ = c.cancel_job_v2(id);
        let msg = rejects(|| { callback(&mut c, who, id, true); });
        assert!(msg.contains("Only the contract can finish a refund"), "{who}: {msg}");
        assert_eq!(status(&c, id), JobV2Status::Cancelling);
    }
}
#[test]
#[should_panic(expected = "Job has no refund in progress")]
fn duplicate_callback_rejected() {
    let mut c = setup();
    let id = job(&mut c);
    at("client.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
    callback(&mut c, CONTRACT, id, true);
    callback(&mut c, CONTRACT, id, true);
}
#[test]
fn cancel_while_refund_pending_is_rejected() {
    let mut c = setup();
    let id = job(&mut c);
    at("client.testnet", n(0), T0);
    let _ = c.cancel_job_v2(id);
    let msg = rejects(|| { let _ = c.cancel_job_v2(id); });
    assert!(msg.contains("Only an Open job can be cancelled"), "{msg}");
}
#[test]
fn refund_calls_need_20_tgas_before_any_state_change() {
    let mut c = setup();
    let id = job(&mut c);
    at_gas("client.testnet", T0, near_sdk::Gas::from_gas(19_999_000_000_000));
    assert!(rejects(|| { let _ = c.cancel_job_v2(id); }).contains("Attach at least 20 Tgas"));
    assert_eq!(status(&c, id), JobV2Status::Open);
    at_gas("client.testnet", T0, MIN_REFUND_CALL_GAS);
    let _ = c.cancel_job_v2(id);
    assert_eq!(status(&c, id), JobV2Status::Cancelling);

    let mut c = setup();
    let id = disputed(&mut c);
    at_gas("owner.testnet", T0, near_sdk::Gas::from_gas(19_999_000_000_000));
    assert!(rejects(|| { let _ = c.resolve_dispute_v2(id, true); }).contains("Attach at least 20 Tgas"));
    assert_eq!(status(&c, id), JobV2Status::Disputed);
}

// ========== 9. Money: escrow is not revenue ==========

#[test]
fn withdraw_revenue_cannot_take_v2_escrow() {
    let mut c = setup();
    job(&mut c);
    delivered_job(&mut c);
    disputed(&mut c);
    at("owner.testnet", n(0), T0);
    let msg = rejects(|| { let _ = c.withdraw_revenue(n(1)); });
    assert!(msg.contains("Amount exceeds earned revenue"), "{msg}");
}
#[test]
fn withdraw_revenue_reaches_only_paid_v2_jobs() {
    let mut c = setup();
    let paid = delivered_job(&mut c);
    delivered_job(&mut c); // still in review: escrow
    at("anyone.testnet", n(0), deadline());
    c.finalize_job_v2(paid);
    at("owner.testnet", n(0), deadline());
    assert!(rejects(|| { let _ = c.withdraw_revenue(n(201)); }).contains("Amount exceeds earned revenue"));
    let _ = c.withdraw_revenue(n(200));
}

// ========== 10. v1 and Remit unaffected ==========

#[test]
fn v1_jobs_and_v2_jobs_have_separate_ids_and_rules() {
    let mut c = setup();
    let v2 = job(&mut c);
    at("client.testnet", n(300), T0);
    let v1 = c.create_job("beauty".into());
    assert_eq!((v1, v2), (0, 0));
    assert!(c.get_job(v1).is_some() && c.get_job_v2(v2).is_some());
    at("worker.testnet", n(0), T0);
    assert!(rejects(|| c.submit_delivery(v1, BRIEF.into(), n(20))).contains("Agent only"));
    at("agent.testnet", n(0), T0);
    assert!(rejects(|| c.submit_delivery_v2(v2, sha256_hex(TEXT), n(20), TEXT.into())).contains("Worker only"));
    c.submit_delivery(v1, BRIEF.into(), n(20));
    at("client.testnet", n(0), T0);
    let _ = c.refund_job(v1); // v1 keeps its old rule: refund after delivery
    assert_eq!(c.get_job(v1).unwrap().status, JobStatus::Refunded);
    assert_eq!(status(&c, v2), JobV2Status::Open);
}
#[test]
fn v2_shares_industry_budget_with_v1_and_reallocate_still_works() {
    let mut c = setup();
    delivered_job(&mut c);
    at("agent.testnet", n(0), T0);
    c.reallocate("beauty".into(), "food".into(), n(480));
    assert_eq!(beauty(&c).budget, n(20));
    let id = job(&mut c);
    at("worker.testnet", n(0), T0);
    assert!(rejects(|| c.submit_delivery_v2(id, sha256_hex(TEXT), n(1), TEXT.into())).contains("Industry budget exceeded"));
}
#[test]
fn remit_still_works_next_to_v2() {
    let mut c = setup();
    c.set_remit_config(acc("payout.testnet"), n(500));
    job(&mut c);
    at("sender.testnet", n(100), T0);
    let order = c.create_order("2".repeat(64), 3600);
    assert_eq!(c.get_order(order).unwrap().status, OrderStatus::Open);
    assert_eq!(c.get_job_v2(0).unwrap().status, JobV2Status::Open);
}

// ========== 11. Immutability, method surface, views ==========

#[test]
fn no_code_path_reassigns_brief_fields() {
    let src = include_str!("autopilot.rs");
    for field in ["brief_hash =", "brief_id =", ".brief_hash.push", ".amount =", ".client ="] {
        assert!(!src.contains(field), "autopilot.rs must not contain `{field}`");
    }
}
#[test]
fn autopilot_public_methods_are_exactly_these() {
    let methods: Vec<&str> = include_str!("autopilot.rs")
        .lines()
        .filter_map(|l| l.trim().strip_prefix("pub fn "))
        .map(|l| l.split(['(', '<']).next().unwrap())
        .collect();
    assert_eq!(methods, [
        "set_autopilot", "set_autopilot_paused", "set_worker",
        "create_job_v2", "cancel_job_v2", "dispute_job_v2",
        "submit_delivery_v2", "finalize_job_v2", "resolve_dispute_v2", "on_job_v2_refund",
        "get_autopilot", "get_job_v2", "get_jobs_v2", "get_open_jobs_v2",
    ]);
}
#[test]
fn open_jobs_view_lists_only_open_and_caps_the_page() {
    let mut c = setup();
    let ids: Vec<u64> = (0..60).map(|_| job(&mut c)).collect();
    deliver(&mut c, ids[1], T0);
    let first = c.get_open_jobs_v2(0, 1000);
    assert_eq!(first.len(), 49, "page of 50 ids minus the delivered one");
    assert!(first.iter().all(|j| j.status == JobV2Status::Open));
    assert_eq!(c.get_open_jobs_v2(50, 50).len(), 10);
    assert_eq!(c.get_jobs_v2(0, 5).len(), 5);
    assert!(c.get_jobs_v2(60, 10).is_empty());
}
#[test]
fn pause_and_unpause() {
    let mut c = setup();
    let id = job(&mut c);
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(true);
    assert!(c.get_autopilot().unwrap().paused);
    at("worker.testnet", n(0), T0);
    assert!(rejects(|| c.submit_delivery_v2(id, sha256_hex(TEXT), n(20), TEXT.into())).contains("Autopilot is paused"));
    at("owner.testnet", n(0), T0);
    c.set_autopilot_paused(false);
    deliver(&mut c, id, T0);
    assert_eq!(status(&c, id), JobV2Status::Delivered);
}
#[test]
#[should_panic(expected = "Owner only")]
fn worker_cannot_unpause() {
    let mut c = setup();
    c.set_autopilot_paused(true);
    at("worker.testnet", n(0), T0);
    c.set_autopilot_paused(false);
}
