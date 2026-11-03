use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn n(x: u128) -> NearToken {
    NearToken::from_millinear(x)
}
fn as_user(who: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .build());
}
fn setup() -> Contract {
    as_user("owner.testnet", n(0));
    let mut c = Contract::init(acc("owner.testnet"), acc("agent.testnet"), n(100));
    c.add_industry("beauty".into(), n(500));
    c.add_industry("food".into(), n(500));
    c
}
fn job(c: &mut Contract, industry: &str) -> u64 {
    as_user("client.testnet", n(1000));
    c.create_job(industry.into())
}
fn find(c: &Contract, name: &str) -> Industry {
    c.get_industries().into_iter().find(|(k, _)| k == name).unwrap().1
}

#[test]
fn full_flow_records_profit() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
    as_user("client.testnet", n(0));
    c.approve_job(id);
    let i = find(&c, "beauty");
    assert_eq!(i.revenue, n(1000));
    assert_eq!(i.spent, n(50));
    assert_eq!(i.jobs_paid, 1);
    assert!(c.get_job(id).unwrap().status == JobStatus::Paid);
}

#[test]
fn refund_marks_job_and_counts() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
    as_user("client.testnet", n(0));
    let _ = c.refund_job(id);
    assert!(c.get_job(id).unwrap().status == JobStatus::Refunded);
    assert_eq!(find(&c, "beauty").jobs_refunded, 1);
}

#[test]
#[should_panic(expected = "Job is already settled")]
fn cannot_refund_after_paid() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
    as_user("client.testnet", n(0));
    c.approve_job(id);
    let _ = c.refund_job(id);
}

#[test]
#[should_panic(expected = "Job is already settled")]
fn cannot_refund_twice() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("client.testnet", n(0));
    let _ = c.refund_job(id);
    let _ = c.refund_job(id);
}

#[test]
#[should_panic(expected = "Only the client can approve")]
fn agent_cannot_approve_own_work() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
    c.approve_job(id);
}

#[test]
#[should_panic(expected = "Cost exceeds the per-job limit")]
fn per_job_limit_is_enforced() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(101));
}

#[test]
#[should_panic(expected = "Industry budget exceeded")]
fn industry_budget_is_enforced() {
    let mut c = setup();
    as_user("owner.testnet", n(0));
    c.add_industry("small".into(), n(10));
    let id = job(&mut c, "small");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
}

#[test]
#[should_panic(expected = "Agent only")]
fn stranger_cannot_deliver() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("client.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(1));
}

#[test]
#[should_panic(expected = "Owner only")]
fn agent_cannot_change_limits() {
    let mut c = setup();
    as_user("agent.testnet", n(0));
    c.set_max_job_cost(n(999));
}

#[test]
fn reallocate_keeps_total_budget() {
    let mut c = setup();
    as_user("agent.testnet", n(0));
    c.reallocate("beauty".into(), "food".into(), n(200));
    assert_eq!(find(&c, "beauty").budget, n(300));
    assert_eq!(find(&c, "food").budget, n(700));
}

#[test]
#[should_panic(expected = "Not enough unspent budget")]
fn cannot_reallocate_spent_budget() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(100));
    c.reallocate("beauty".into(), "food".into(), n(401));
}

#[test]
#[should_panic(expected = "Target is paused")]
fn cannot_fund_paused_industry() {
    let mut c = setup();
    as_user("owner.testnet", n(0));
    c.pause_industry("food".into());
    as_user("agent.testnet", n(0));
    c.reallocate("beauty".into(), "food".into(), n(1));
}

#[test]
#[should_panic(expected = "Industry is paused")]
fn paused_industry_rejects_jobs() {
    let mut c = setup();
    as_user("owner.testnet", n(0));
    c.pause_industry("beauty".into());
    job(&mut c, "beauty");
}

#[test]
fn owner_withdraws_earned_revenue() {
    let mut c = setup();
    let id = job(&mut c, "beauty");
    as_user("agent.testnet", n(0));
    c.submit_delivery(id, HASH.into(), n(50));
    as_user("client.testnet", n(0));
    c.approve_job(id);
    as_user("owner.testnet", n(0));
    let _ = c.withdraw_revenue(n(1000));
}

#[test]
#[should_panic(expected = "Amount exceeds earned revenue")]
fn owner_cannot_touch_escrow() {
    let mut c = setup();
    job(&mut c, "beauty");
    as_user("owner.testnet", n(0));
    let _ = c.withdraw_revenue(n(1));
}

#[test]
#[should_panic(expected = "Owner only")]
fn agent_cannot_withdraw() {
    let mut c = setup();
    as_user("agent.testnet", n(0));
    let _ = c.withdraw_revenue(n(1));
}
