// Pure checks the monitor runs every 60 s. Each returns a list of trip reasons (empty = OK).

const PENDING = new Set(['Cancelling', 'Refunding']);
const ESCROW = new Set(['Open', 'Delivered', 'Disputed', 'Cancelling', 'Refunding']);
const big = (x) => BigInt(x);
export const NEAR = 10n ** 24n;
export const MILLI = 10n ** 21n;

/**
 * @param base  snapshot taken before the run
 * @param now   current snapshot
 * @param seen  Map jobId → first time (ms) it was seen in a pending state (mutated)
 * @param nowMs current time
 */
export function checkChain(base, now, seen, nowMs, { stuckMs = 120_000, minAllowance = 9n * 10n ** 23n, balanceTolerance = 20n * MILLI } = {}) {
  const trips = [];

  // 1. Jobs stuck in Cancelling/Refunding for more than 2 minutes.
  for (const j of now.jobs) {
    if (PENDING.has(j.status)) {
      if (!seen.has(j.id)) seen.set(j.id, nowMs);
      if (nowMs - seen.get(j.id) > stuckMs) trips.push(`job ${j.id} stuck in ${j.status} for over ${stuckMs / 1000}s`);
    } else seen.delete(j.id);
  }

  // 2. Revenue: the ledger must add up, and grow only by v2 jobs Paid since the start.
  const indSum = now.industries.reduce((s, [, i]) => s + big(i.revenue), 0n);
  if (indSum !== big(now.core.total_revenue)) trips.push(`industry revenue ${indSum} != total_revenue ${now.core.total_revenue}`);
  const basePaid = new Set(base.jobs.filter((j) => j.status === 'Paid').map((j) => j.id));
  const newPaid = now.jobs.filter((j) => j.status === 'Paid' && !basePaid.has(j.id)).reduce((s, j) => s + big(j.amount), 0n);
  const expectedRevenue = big(base.core.total_revenue) + newPaid;
  if (big(now.core.total_revenue) !== expectedRevenue) trips.push(`total_revenue ${now.core.total_revenue} != expected ${expectedRevenue}`);
  if (now.core.withdrawn !== base.core.withdrawn) trips.push('withdrawn changed during the run');

  // 3. Escrow and contract balance: balance moves only by new deposits minus completed refunds.
  //    Skipped while a refund is in flight (the transfer and the status change are two receipts).
  if (!now.jobs.some((j) => PENDING.has(j.status))) {
    const baseIds = new Set(base.jobs.map((j) => j.id));
    let expectedDelta = 0n;
    for (const j of now.jobs) {
      const wasEscrowed = baseIds.has(j.id) ? ESCROW.has(base.jobs.find((b) => b.id === j.id).status) : false;
      const isOut = j.status === 'Cancelled' || j.status === 'Refunded';
      if (!baseIds.has(j.id)) expectedDelta += big(j.amount);
      if (isOut && (wasEscrowed || !baseIds.has(j.id))) expectedDelta -= big(j.amount);
    }
    const delta = big(now.balances.contract) - big(base.balances.contract);
    const diff = delta - expectedDelta;
    // Gas rewards make the contract balance drift up slightly; it must never drift down.
    if (diff < -MILLI || diff > balanceTolerance) trips.push(`contract balance delta ${delta} vs expected ${expectedDelta} (diff ${diff})`);
  }
  const escrow = now.jobs.filter((j) => ESCROW.has(j.status)).reduce((s, j) => s + big(j.amount), 0n);
  if (big(now.balances.contract) < escrow + big(now.core.total_revenue) - big(now.core.withdrawn)) trips.push('contract balance below escrow + unwithdrawn revenue');

  // 4. Worker key allowance and balance.
  if (now.allowance === null) trips.push('worker function-call key not found');
  else if (big(now.allowance) < minAllowance) trips.push(`worker allowance ${now.allowance} below 0.9 NEAR`);
  if (big(base.balances.worker) - big(now.balances.worker) > 50n * MILLI) trips.push('worker account balance dropped by more than 0.05 NEAR');

  // 5. Contract-side limits.
  if (now.autopilot.delivered_today > now.autopilot.max_deliveries_per_day) trips.push('delivered_today above the daily limit');

  return { trips, escrow };
}

/**
 * Reads worker report lines. Trips on: 3 NEAR AI failures in a row; any non-transient error
 * repeating 3 times; 5 transient RPC errors in a row (one 429 never trips); a fatal error.
 */
export function checkWorkerReports(reports, { maxConsecutiveAi = 3, maxRepeat = 3, maxConsecutiveTransient = 5 } = {}) {
  const trips = [];
  let consecutiveAi = 0;
  let consecutiveTransient = 0;
  const counts = new Map();
  for (const r of reports) {
    if (r.fatal) trips.push(`worker fatal error: ${r.fatal}`);
    if (r.transient_error) {
      consecutiveTransient = r.consecutive ?? consecutiveTransient + 1;
      if (consecutiveTransient >= maxConsecutiveTransient) trips.push(`worker hit ${consecutiveTransient} transient RPC errors in a row`);
      continue;
    }
    if ('delivered' in r || 'finalized' in r) consecutiveTransient = 0;
    for (const f of r.failed ?? []) {
      if (f.transient) continue; // retried with backoff and failover; persistent cases trip above
      if (f.step === 'generate' && /NEAR AI/.test(f.reason)) continue; // covered by the consecutive rule
      const key = `${f.step}: ${f.reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const aiFail = (r.failed ?? []).some((f) => f.step === 'generate' && /NEAR AI/.test(f.reason));
    if (aiFail) consecutiveAi += 1;
    else if ((r.delivered ?? []).length) consecutiveAi = 0;
    if (consecutiveAi >= maxConsecutiveAi) { trips.push(`NEAR AI failed ${consecutiveAi} times in a row`); break; }
  }
  for (const [k, n] of counts) if (n >= maxRepeat) trips.push(`repeated error x${n}: ${k}`);
  return [...new Set(trips)];
}

/** Parses "[ISO] {json}" lines written by agent/worker.mjs. Non-report lines are returned as crashes. */
export function parseWorkerLog(text) {
  const reports = [];
  const other = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[[^\]]+\] (\{.*\})$/);
    if (m) { try { reports.push(JSON.parse(m[1])); continue; } catch { /* fallthrough */ } }
    if (line.trim()) other.push(line.slice(0, 200));
  }
  return { reports, other };
}
