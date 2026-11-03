use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobStatus {
    Open,
    Delivered,
    Paid,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub client: AccountId,
    pub industry: String,
    pub amount: NearToken,
    pub status: JobStatus,
    pub cost: NearToken,
    /// SHA-256 of the deliverable. The content itself stays off-chain.
    pub deliverable_hash: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Industry {
    pub enabled: bool,
    pub budget: NearToken,
    pub spent: NearToken,
    pub revenue: NearToken,
    pub jobs_paid: u32,
    pub jobs_refunded: u32,
}

#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    agent: AccountId,
    max_job_cost: NearToken,
    next_job_id: u64,
    total_revenue: NearToken,
    withdrawn: NearToken,
    jobs: LookupMap<u64, Job>,
    industries: IterableMap<String, Industry>,
}

impl Default for Contract {
    fn default() -> Self {
        env::panic_str("Contract must be initialized with init")
    }
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId, agent: AccountId, max_job_cost: NearToken) -> Self {
        require!(owner != agent, "Owner and agent must be different accounts");
        Self {
            owner,
            agent,
            max_job_cost,
            next_job_id: 0,
            total_revenue: NearToken::from_yoctonear(0),
            withdrawn: NearToken::from_yoctonear(0),
            jobs: LookupMap::new(b"j"),
            industries: IterableMap::new(b"i"),
        }
    }

    // ---------- Owner: sets the rules ----------

    pub fn add_industry(&mut self, name: String, budget: NearToken) {
        self.assert_owner();
        require!(self.industries.get(&name).is_none(), "Industry already exists");
        self.industries.insert(
            name,
            Industry {
                enabled: true,
                budget,
                spent: NearToken::from_yoctonear(0),
                revenue: NearToken::from_yoctonear(0),
                jobs_paid: 0,
                jobs_refunded: 0,
            },
        );
    }

    pub fn set_max_job_cost(&mut self, max_job_cost: NearToken) {
        self.assert_owner();
        self.max_job_cost = max_job_cost;
    }

    /// Emergency stop for one industry.
    pub fn pause_industry(&mut self, name: String) {
        self.assert_owner();
        self.industry_mut(&name).enabled = false;
    }

    /// Withdraws earned revenue only. Money held for open jobs cannot be touched.
    pub fn withdraw_revenue(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        let available = self.total_revenue.saturating_sub(self.withdrawn);
        require!(amount <= available, "Amount exceeds earned revenue");
        self.withdrawn = self.withdrawn.saturating_add(amount);
        Promise::new(self.owner.clone()).transfer(amount)
    }

    // ---------- Client ----------

    #[payable]
    pub fn create_job(&mut self, industry: String) -> u64 {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "Attach a deposit to create a job");
        let info = self.industries.get(&industry).expect("Unknown industry");
        require!(info.enabled, "Industry is paused");

        let id = self.next_job_id;
        self.next_job_id += 1;
        self.jobs.insert(
            id,
            Job {
                id,
                client: env::predecessor_account_id(),
                industry,
                amount,
                status: JobStatus::Open,
                cost: NearToken::from_yoctonear(0),
                deliverable_hash: None,
            },
        );
        id
    }

    /// Client accepts the work. Payment stays in the contract as revenue.
    pub fn approve_job(&mut self, job_id: u64) {
        let mut job = self.job(job_id);
        require!(job.client == env::predecessor_account_id(), "Only the client can approve");
        require!(job.status == JobStatus::Delivered, "Job is not delivered");
        job.status = JobStatus::Paid;

        let info = self.industry_mut(&job.industry);
        info.revenue = info.revenue.saturating_add(job.amount);
        info.jobs_paid += 1;
        self.total_revenue = self.total_revenue.saturating_add(job.amount);
        self.jobs.insert(job_id, job);
    }

    /// Client rejects delivered work, or cancels work not delivered yet.
    pub fn refund_job(&mut self, job_id: u64) -> Promise {
        let mut job = self.job(job_id);
        require!(job.client == env::predecessor_account_id(), "Only the client can refund");
        require!(
            job.status == JobStatus::Open || job.status == JobStatus::Delivered,
            "Job is already settled"
        );
        job.status = JobStatus::Refunded;
        let (client, amount, industry) = (job.client.clone(), job.amount, job.industry.clone());
        self.jobs.insert(job_id, job);

        self.industry_mut(&industry).jobs_refunded += 1;
        Promise::new(client).transfer(amount)
    }

    // ---------- Agent: cannot move money ----------

    /// Records delivery and its cost. Enforces the per-job cap and industry budget.
    pub fn submit_delivery(&mut self, job_id: u64, deliverable_hash: String, cost: NearToken) {
        self.assert_agent();
        require!(cost <= self.max_job_cost, "Cost exceeds the per-job limit");
        require!(deliverable_hash.len() == 64, "Expected a SHA-256 hex hash");

        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Open, "Job is not open");

        let info = self.industry_mut(&job.industry);
        require!(info.enabled, "Industry is paused");
        let spent = info.spent.saturating_add(cost);
        require!(spent <= info.budget, "Industry budget exceeded");
        info.spent = spent;

        job.status = JobStatus::Delivered;
        job.cost = cost;
        job.deliverable_hash = Some(deliverable_hash);
        self.jobs.insert(job_id, job);
    }

    /// Moves budget between enabled industries. Total budget cannot grow.
    pub fn reallocate(&mut self, from: String, to: String, amount: NearToken) {
        self.assert_agent();
        require!(from != to, "Choose two different industries");
        require!(self.industries.get(&to).expect("Unknown industry").enabled, "Target is paused");

        let source = self.industry_mut(&from);
        let free = source.budget.saturating_sub(source.spent);
        require!(amount <= free, "Not enough unspent budget");
        source.budget = source.budget.saturating_sub(amount);

        let target = self.industry_mut(&to);
        target.budget = target.budget.saturating_add(amount);
    }

    // ---------- Views ----------

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    pub fn get_industries(&self) -> Vec<(String, Industry)> {
        self.industries.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    // ---------- Internal ----------

    fn job(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().expect("Unknown job")
    }

    fn industry_mut(&mut self, name: &String) -> &mut Industry {
        self.industries.get_mut(name).expect("Unknown industry")
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "Agent only");
    }
}

#[cfg(test)]
mod tests;
