//! Jobs v2 ("autopilot"): the owner sets limits; the worker finds, does and delivers jobs
//! on its own; payment is released automatically after a review window.
//!
//! - State lives under its own keys (`ap:*`), so the `Contract` struct and the v1 job and
//!   Remit storage are unchanged and the deployed contract needs no migration.
//! - v2 jobs share the v1 industries (budget, spent, revenue, job counts) and `total_revenue`,
//!   so the existing ledger and `withdraw_revenue` see them. Escrow only becomes revenue
//!   when a job is Paid.
//! - Briefs are not stored: a job carries `brief_id` + `brief_hash` of a fictional brief from
//!   the public catalog. Deliverable text is passed in the transaction, checked against its
//!   hash and size, and not stored.
//! - Refunds use a private callback: Cancelled/Refunded only after the transfer succeeded.
//! - The owner arbitrates disputes. That is acceptable for a demo only.

use crate::*;
use near_sdk::borsh;
use near_sdk::json_types::U64;
use near_sdk::{Gas, PromiseError, PromiseOrValue};

const CONFIG_KEY: &[u8] = b"ap:cfg";
const JOB_PREFIX: &[u8] = b"ap:j:";
const NS_PER_SEC: u64 = 1_000_000_000;
const DAY_NS: u64 = 86_400 * NS_PER_SEC;
pub const MIN_REVIEW_SECS: u32 = 300;
pub const MAX_REVIEW_SECS: u32 = 7 * 24 * 3600;
/// Hard ceiling for the owner's daily delivery limit.
pub const MAX_DELIVERIES_PER_DAY: u32 = 10;
/// Largest deliverable accepted, in UTF-8 bytes.
pub const MAX_DELIVERABLE_BYTES: usize = 4096;
pub const MAX_PAGE: u64 = 50;
const REFUND_CALLBACK_GAS: Gas = Gas::from_tgas(10);
pub const MIN_REFUND_CALL_GAS: Gas = Gas::from_tgas(20);

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobV2Status {
    Open,
    /// Client cancelled an Open job; refund transfer sent, waiting for the callback.
    Cancelling,
    Cancelled,
    Delivered,
    Disputed,
    /// Owner ruled a refund on a disputed job; transfer sent, waiting for the callback.
    Refunding,
    Refunded,
    Paid,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct AutopilotConfig {
    pub worker: AccountId,
    pub paused: bool,
    pub review_window_secs: u32,
    pub min_job_price: NearToken,
    pub max_deliveries_per_day: u32,
    pub next_job_id: u64,
    pub day_index: u64,
    pub delivered_today: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct JobV2 {
    pub id: u64,
    pub client: AccountId,
    pub industry: String,
    pub amount: NearToken,
    /// Id of a fictional brief in the public catalog (`briefs/<id>.json`).
    pub brief_id: String,
    /// SHA-256 (lowercase hex) of that brief's text.
    pub brief_hash: String,
    pub status: JobV2Status,
    pub cost: NearToken,
    pub deliverable_hash: Option<String>,
    pub delivered_at_ns: Option<U64>,
    pub review_deadline_ns: Option<U64>,
}

#[near]
impl Contract {
    // ---------- Owner: limits and emergency controls ----------

    pub fn set_autopilot(
        &mut self,
        worker: AccountId,
        review_window_secs: u32,
        min_job_price: NearToken,
        max_deliveries_per_day: u32,
        paused: bool,
    ) {
        self.assert_owner();
        self.check_worker(&worker);
        require!(
            (MIN_REVIEW_SECS..=MAX_REVIEW_SECS).contains(&review_window_secs),
            "review_window_secs must be between 300 and 604800"
        );
        require!(min_job_price > self.max_job_cost, "min_job_price must be above max_job_cost");
        require!(
            (1..=MAX_DELIVERIES_PER_DAY).contains(&max_deliveries_per_day),
            "max_deliveries_per_day must be between 1 and 10"
        );
        let prev = ap_read_config();
        ap_write_config(&AutopilotConfig {
            worker,
            paused,
            review_window_secs,
            min_job_price,
            max_deliveries_per_day,
            next_job_id: prev.as_ref().map_or(0, |c| c.next_job_id),
            day_index: prev.as_ref().map_or(0, |c| c.day_index),
            delivered_today: prev.as_ref().map_or(0, |c| c.delivered_today),
        });
    }

    /// Emergency stop: blocks new jobs, deliveries and finalization at once.
    pub fn set_autopilot_paused(&mut self, paused: bool) {
        self.assert_owner();
        let mut cfg = ap_config();
        cfg.paused = paused;
        ap_write_config(&cfg);
    }

    /// Emergency stop for a compromised worker key: point the worker role elsewhere.
    pub fn set_worker(&mut self, worker: AccountId) {
        self.assert_owner();
        self.check_worker(&worker);
        let mut cfg = ap_config();
        cfg.worker = worker;
        ap_write_config(&cfg);
    }

    // ---------- Client ----------

    #[payable]
    pub fn create_job_v2(&mut self, industry: String, brief_id: String, brief_hash: String) -> u64 {
        let mut cfg = ap_config();
        require!(!cfg.paused, "Autopilot is paused");
        let client = env::predecessor_account_id();
        require!(client != cfg.worker && client != self.agent, "Worker and agent cannot create jobs");
        require!(client != self.owner, "Owner cannot be a client");
        let amount = env::attached_deposit();
        require!(amount >= cfg.min_job_price, "Deposit is below min_job_price");
        let info = self.industries.get(&industry).expect("Unknown industry");
        require!(info.enabled, "Industry is paused");
        require!(is_brief_id(&brief_id), "brief_id must be 1-40 characters of a-z, 0-9 or -");
        require!(is_sha256_hex(&brief_hash), "brief_hash must be 64 lowercase hex characters");

        let id = cfg.next_job_id;
        cfg.next_job_id += 1;
        ap_write_job(&JobV2 {
            id,
            client,
            industry,
            amount,
            brief_id,
            brief_hash,
            status: JobV2Status::Open,
            cost: NearToken::from_yoctonear(0),
            deliverable_hash: None,
            delivered_at_ns: None,
            review_deadline_ns: None,
        });
        ap_write_config(&cfg);
        id
    }

    /// Client cancels a job the worker has not delivered yet. Allowed while paused.
    pub fn cancel_job_v2(&mut self, job_id: u64) -> Promise {
        require_refund_gas();
        let mut job = ap_job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can cancel");
        require!(job.status == JobV2Status::Open, "Only an Open job can be cancelled");
        job.status = JobV2Status::Cancelling;
        ap_write_job(&job);
        refund_then_finish(job.client, job.amount, job_id)
    }

    /// Client objects to a delivery before the review deadline. While autopilot is paused,
    /// a delivered job can also be disputed after its deadline (it cannot be finalized then).
    pub fn dispute_job_v2(&mut self, job_id: u64) {
        let cfg = ap_config();
        let mut job = ap_job(job_id);
        require!(env::predecessor_account_id() == job.client, "Only the client can dispute");
        require!(job.status == JobV2Status::Delivered, "Only a Delivered job can be disputed");
        let deadline = job.review_deadline_ns.expect("Delivered job has a deadline").0;
        require!(env::block_timestamp() < deadline || cfg.paused, "Review window has closed");
        job.status = JobV2Status::Disputed;
        ap_write_job(&job);
    }

    // ---------- Worker ----------

    /// Records a delivery. `text` must hash to `deliverable_hash`; it is checked, not stored.
    pub fn submit_delivery_v2(&mut self, job_id: u64, deliverable_hash: String, cost: NearToken, text: String) {
        let mut cfg = ap_config();
        require!(env::predecessor_account_id() == cfg.worker, "Worker only");
        require!(!cfg.paused, "Autopilot is paused");
        require!(!text.is_empty() && text.len() <= MAX_DELIVERABLE_BYTES, "Deliverable must be 1-4096 bytes");
        require!(is_sha256_hex(&deliverable_hash), "deliverable_hash must be 64 lowercase hex characters");
        require!(sha256_hex(&text) == deliverable_hash, "deliverable_hash does not match text");
        require!(cost <= self.max_job_cost, "Cost exceeds the per-job limit");

        let mut job = ap_job(job_id);
        require!(job.status == JobV2Status::Open, "Job is not open");

        let now = env::block_timestamp();
        let today = now / DAY_NS;
        if today != cfg.day_index {
            cfg.day_index = today;
            cfg.delivered_today = 0;
        }
        require!(cfg.delivered_today < cfg.max_deliveries_per_day, "Daily delivery limit reached");

        let info = self.industry_mut(&job.industry);
        require!(info.enabled, "Industry is paused");
        let spent = info.spent.saturating_add(cost);
        require!(spent <= info.budget, "Industry budget exceeded");
        info.spent = spent;

        cfg.delivered_today += 1;
        job.status = JobV2Status::Delivered;
        job.cost = cost;
        job.deliverable_hash = Some(deliverable_hash);
        job.delivered_at_ns = Some(U64(now));
        job.review_deadline_ns = Some(U64(now + u64::from(cfg.review_window_secs) * NS_PER_SEC));
        ap_write_job(&job);
        ap_write_config(&cfg);
    }

    // ---------- Anyone ----------

    /// Releases payment once the review window has passed without a dispute.
    pub fn finalize_job_v2(&mut self, job_id: u64) {
        let cfg = ap_config();
        require!(!cfg.paused, "Autopilot is paused");
        let mut job = ap_job(job_id);
        require!(job.status == JobV2Status::Delivered, "Only a Delivered job can be finalized");
        let deadline = job.review_deadline_ns.expect("Delivered job has a deadline").0;
        require!(env::block_timestamp() >= deadline, "Review window is still open");
        self.pay(&mut job);
    }

    // ---------- Owner: dispute arbiter (demo only) ----------

    pub fn resolve_dispute_v2(&mut self, job_id: u64, refund: bool) -> PromiseOrValue<JobV2Status> {
        self.assert_owner();
        let mut job = ap_job(job_id);
        require!(job.status == JobV2Status::Disputed, "Only a Disputed job can be resolved");
        if !refund {
            self.pay(&mut job);
            return PromiseOrValue::Value(JobV2Status::Paid);
        }
        require_refund_gas();
        job.status = JobV2Status::Refunding;
        ap_write_job(&job);
        PromiseOrValue::Promise(refund_then_finish(job.client.clone(), job.amount, job_id))
    }

    // ---------- Callback (contract only) ----------

    #[private]
    pub fn on_job_v2_refund(&mut self, job_id: u64) -> JobV2Status {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the contract can finish a refund"
        );
        let mut job = ap_job(job_id);
        let ok = match env::promise_result_checked(0, 0) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(_) => false,
        };
        job.status = match (&job.status, ok) {
            (JobV2Status::Cancelling, true) => JobV2Status::Cancelled,
            (JobV2Status::Cancelling, false) => JobV2Status::Open,
            (JobV2Status::Refunding, true) => {
                self.industry_mut(&job.industry).jobs_refunded += 1;
                JobV2Status::Refunded
            }
            (JobV2Status::Refunding, false) => JobV2Status::Disputed,
            _ => env::panic_str("Job has no refund in progress"),
        };
        env::log_str(&format!("job_v2 {} refund {}: {:?}", job_id, if ok { "ok" } else { "failed" }, job.status));
        ap_write_job(&job);
        job.status
    }

    // ---------- Views ----------

    pub fn get_autopilot(&self) -> Option<AutopilotConfig> {
        ap_read_config()
    }

    pub fn get_job_v2(&self, job_id: u64) -> Option<JobV2> {
        ap_read_job(job_id)
    }

    /// Jobs with ids in [from, from + limit), any status. limit is capped at 50.
    pub fn get_jobs_v2(&self, from: u64, limit: u64) -> Vec<JobV2> {
        let next = ap_read_config().map_or(0, |c| c.next_job_id);
        let end = next.min(from.saturating_add(limit.min(MAX_PAGE)));
        (from..end).filter_map(ap_read_job).collect()
    }

    /// Open jobs among ids in [from, from + limit). limit is capped at 50.
    pub fn get_open_jobs_v2(&self, from: u64, limit: u64) -> Vec<JobV2> {
        self.get_jobs_v2(from, limit).into_iter().filter(|j| j.status == JobV2Status::Open).collect()
    }

    // ---------- Internal ----------

    fn check_worker(&self, worker: &AccountId) {
        require!(*worker != self.owner, "Worker cannot be the owner");
        require!(*worker != self.agent, "Worker cannot be the v1 agent");
    }

    /// Delivered or Disputed → Paid. The escrow becomes revenue exactly once.
    fn pay(&mut self, job: &mut JobV2) {
        job.status = JobV2Status::Paid;
        let amount = job.amount;
        let info = self.industry_mut(&job.industry);
        info.revenue = info.revenue.saturating_add(amount);
        info.jobs_paid += 1;
        self.total_revenue = self.total_revenue.saturating_add(amount);
        ap_write_job(job);
    }
}

fn require_refund_gas() {
    require!(env::prepaid_gas() >= MIN_REFUND_CALL_GAS, "Attach at least 20 Tgas");
}

fn refund_then_finish(to: AccountId, amount: NearToken, job_id: u64) -> Promise {
    Promise::new(to).transfer(amount).then(
        Contract::ext(env::current_account_id())
            .with_static_gas(REFUND_CALLBACK_GAS)
            .on_job_v2_refund(job_id),
    )
}

pub(crate) fn sha256_hex(text: &str) -> String {
    env::sha256(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_brief_id(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn job_key(id: u64) -> Vec<u8> {
    [JOB_PREFIX, &id.to_le_bytes()].concat()
}

fn ap_read_config() -> Option<AutopilotConfig> {
    env::storage_read(CONFIG_KEY).map(|b| borsh::from_slice(&b).expect("Bad autopilot config"))
}

fn ap_config() -> AutopilotConfig {
    ap_read_config().expect("Autopilot is not configured")
}

fn ap_write_config(cfg: &AutopilotConfig) {
    env::storage_write(CONFIG_KEY, &borsh::to_vec(cfg).unwrap());
}

fn ap_read_job(id: u64) -> Option<JobV2> {
    env::storage_read(&job_key(id)).map(|b| borsh::from_slice(&b).expect("Bad v2 job"))
}

fn ap_job(id: u64) -> JobV2 {
    ap_read_job(id).expect("Unknown v2 job")
}

fn ap_write_job(job: &JobV2) {
    env::storage_write(&job_key(job.id), &borsh::to_vec(job).unwrap());
}
