# Jobs v2 autopilot — testnet log

All on testnet, 2026-11-04 (UTC). Explorer links: https://testnet.nearblocks.io/txns/<hash>

## Deploy
- `max_job_cost` on chain is 0.1 NEAR, so `min_job_price` was set to **0.15 NEAR** (it must be strictly above the cap).
- Before the deploy, the wasm on chain was `8yKJM736…HuYe`. It was backed up and matched the on-chain `code_hash`.
- The deployed wasm is `9RukY7tqnP6FL5k8CeW4miPA7gTiw1hkq3xR8cxnRWzV` (tx `FPFeWj5hf6tk2xnEEGj7tU6m9HVaAwoE35aW36UsKyiN`), and the `code_hash` matched.
- These were byte-identical before and after the deploy: `get_industries`, v1 `get_job` 0–11, `get_remit_config`, `get_order` 0–5, and the core STATE (`total_revenue` 2.05, `withdrawn` 0). `get_autopilot` returned `null` before configuration.

## Worker account
- `worker-long2222.testnet` was created in tx `43mLE3rh56QBSe33husPSPapMEsgTq4eX2knGGjSq3Mx`.
- A function-call key `ed25519:DKwir2bYP2CF1yTnrmY5u1hoMpRW6pMZmqftJ1fz8byP` was added for `submit_delivery_v2` and `finalize_job_v2` only, with an allowance of 1 NEAR (tx `Bnb6xRvmwSppETTCwn7Kra7Mp5cSQeRrR92LvkWv28H7`).
- After the cycle below succeeded, the full-access key was deleted (tx `9donxqr5LzGof2GX15QkyFfYJ4QXKreBF1NMT2YAYLNo`). `list-keys` now shows only that function-call key.

## Cycle
| Step | Tx | Result |
|---|---|---|
| `set_autopilot` (review 600 s, min 0.15 NEAR, 10/day, paused) | `2xDXnwoZpvoK33Fkjq9QvkG6wkA8jPCEmAVMiR7eUAeQ` | The worker reported `paused` and delivered nothing |
| Unpause | `EpFPpMXkCVfcL9RgDV4pEABTiBCQuE7hfhJeYKyob8Nd` | |
| Job 0 created (beauty, `lani-nails-fall`, 0.25 NEAR) | `7jG2ZKZbuW9TkcTwoQz7hbAqwPkQ3w5jAdZ82fcucGGR` | |
| Worker delivers job 0 | `8jJCoAzjH8FHgCFvA2gnHTeYv4HKCsRB8BdwR6PWyiKr` | Signed by `DKwir2…`; 279 bytes; 2.61 Tgas |
| Job 1 created (fitness, `makai-fit-class`, 0.25 NEAR) | `Hug2DkQ48CkyQJBsXzR8ormKp41NmJgw2KxB8YZhEqcw` | |
| 4090-byte filler delivery with cost 0 (gas measurement, not real work) | `7s8QCUMPvphJDWUVpQW6cpcdJakHaG7vvqoQTGYUxb65` | 0.51 + 2.22 + 0.22 = **2.95 Tgas**; fee 0.000273 NEAR |
| Client disputes job 1 within the window | `5stNFZvwugUftqVw2CqGgdMybPu7RmqqjcMxNpG7ZBDp` | Disputed |
| Owner resolves job 1 with a refund | `ArGNL91JS7KEDYXMGhMzcsHQC5YvoS2MxaLVZsMRSdTq` | The transfer sent 0.25 NEAR to the client, and `on_job_v2_refund` returned `"Refunded"`. Client balance rose by exactly 0.25 NEAR, `total_revenue` did not change, and fitness `jobs_refunded` went from 0 to 1 |
| Worker finalizes job 0 after the window | `GMkuRGCdDtXzYRv1ScHz1H9GBwurChp5CnGYExybCWYy` | Paid; 2.39 Tgas. `total_revenue` went from 2.05 to 2.30; beauty revenue +0.25 and `jobs_paid` 4→5. A second pass did not finalize again |
| Job 2 created (food, `pho-lani-review`, 0.15 NEAR) | `HynsRkKdzbWckUH9gtKtynTADPJ1mjdD1QABrsL73eMp` | Used for the stop drills |
| `set_autopilot_paused(true)` | `6wJEx4pfiCZVDWrmDSwdCtPkTriBZNWYW2VDDzhwkWsp` | Autopilot was left paused |

## Stop drills
- **`agent/STOP`:** both `--once` and `--loop` stopped before any chain or model call. Job 2 stayed Open, and the worker state had no entry for it.
- **Contract pause:** the worker reported `paused`. A direct `submit_delivery_v2` signed with the worker key was rejected by the contract ("Smart contract panicked: Autopilot is paused"); the client printed no hash for it. Job 2 stayed Open.

## Found and fixed during the run
- On the first live pass, the worker built its `Account` from a `KeyPair` object, which cannot sign. The error was "signer.signTransaction is not a function", and no transaction was sent. The fix (commit `7d5eb71`) passes the key string, as `agent/signer.mjs` does, and a regression test was added. The retry delivered job 0.

## After the run
- v1 jobs 0–11, `get_remit_config` and orders 0–5 are byte-identical to the pre-deploy snapshot.
- The core STATE shows `total_revenue` 2.30 (+0.25 from v2 job 0 only) and `withdrawn` 0.
- v2 jobs: 0 Paid, 1 Refunded, 2 Open (0.15 NEAR escrow). Autopilot is paused, with `delivered_today` = 2.

## Soak runs (2026-11-04)

Setup: `scripts/soak/run.sh` starts three separate `nohup` processes, plus `caffeinate` tied to the monitor:
- the worker (`--loop --interval 60`, `WORKER_MAX_JOBS_PER_RUN=1`, `WORKER_MAX_COST_NEAR_PER_DAY=0.5`);
- the simulated client (`scripts/soak/client.mjs`);
- the monitor (`scripts/soak/monitor.mjs`).

Every 60 s the monitor checks for stuck refunds (over 2 min), revenue/escrow/balance drift, worker allowance below 0.9 NEAR, repeated or consecutive errors, and a dead worker. On any of these it pauses autopilot and stops the run. Logs stay local in `backups/` and are not committed. A scan found no keys, tokens or `.env` values in them.

### Run 1: tripped after about 4 minutes (16:24–16:28 UTC)
- `rpc.testnet.near.org` answered HTTP 429 "WARNING! THIS ENDPOINT IS DEPRECATED!". The worker did not catch the error and exited.
- The monitor tripped as designed: it created `agent/STOP`, stopped the client, and paused on chain (tx `H7H51BGWFqpXpXK7btUmgXtcaSxyhegxmwtcZRsbzfEu`). The state was safe: jobs 2 and 3 were Delivered, 0.35 NEAR was in escrow, and nothing was stuck.
- The fix was commit `ddc875d`:
  - FastNEAR is now the primary RPC, with dRPC and FastNEAR archival as fallbacks.
  - Reads retry with backoff, jitter and failover.
  - Writes are never re-sent blindly: the job is re-read first and the saved text is reused.
  - The worker loop survives transient errors and exits only after 5 in a row.
  - One 429 no longer trips the monitor.

### Run 2: full 3 hours, no trip (17:11–20:16 UTC)
- The worker ran from 17:11:18 to 20:12:12 UTC, stopping at `--until`. The monitor ran until 20:16:53 with 183 ticks and no trip.
- Autopilot was unpaused before the run (tx `DohNZ9Ap4zmjwzjUyPRH8NL3ZVCkovj7hFrWJX5mA2xw`) and paused again after it (tx `DzyaohAPVQ3psQfWsWxvu3BJnPWNdwtYaHihtNC51X2e`).
- **Jobs.** In the run's first pass the worker finalized jobs 2 and 3 (pending from run 1). The simulated client created 6 jobs (4–9) from 4 fictional briefs.

| Job | Brief | Deposit | Result | Deliver tx | Final tx |
|---|---|---|---|---|---|
| 2 | pho-lani-review | 0.15 | Paid | `HcWbb9Tx…` (run 1) | finalize `GDG7oCgr…` |
| 3 | lani-nails-fall | 0.20 | Paid | `GrF48dTm…` (run 1) | finalize `HoKz3dAf…` |
| 4 | lani-nails-fall | 0.20 | Paid | `7HTMDJoi…` | finalize `F9zmAVEw…` |
| 5 | kapalua-condo-listing | 0.25 | Disputed in the window, then the **owner ruled for the worker**: Paid | `9BNshQGy…` | dispute `DyyiojuP…`, resolve `jSADpWZ6…` (returned "Paid", no transfer) |
| 6 | makai-fit-class | 0.15 | Paid | `3KA6kjZz…` | finalize `EM19EWYY…` |
| 7 | pho-lani-review | 0.15 | Created while `agent/STOP` was present and **Cancelled before delivery** | — | cancel `sa39UxQp…`: Transfer 0.15 NEAR to the client, callback returned "Cancelled" |
| 8 | lani-nails-fall | 0.20 | Paid | `CZoBLTgk…` | finalize `Sz92JDiK…` |
| 9 | pho-lani-review | 0.15 | Paid | `DBBKoAHj…` | finalize `4gLBApz1…` |

- **Success rate.** All 7 jobs that needed work (2–6, 8, 9) were delivered and paid: 7/7. The one planned cancel ended Cancelled, and the one planned dispute ended Paid. There were no model, quality or submit failures.
- **STOP drill.** `agent/STOP` was created at 18:11:18. The worker exited at 18:11:29 and the client confirmed it at 18:11:33. Job 7 was created and cancelled while STOP was present and was never delivered (`deliverable_hash` null). STOP was removed at 18:16:26, the worker restarted, and the next jobs were delivered normally.
- **RPC.** There were 0 retries, 0 endpoint switches and 0 write rotations in the worker, 0 client retries, and 0 monitor RPC errors. FastNEAR answered every call, so the failover path was exercised only by unit tests in this run.
- **Reconciliation:**
  - v1 jobs 0–11, Remit config and orders 0–5 are byte-identical before and after the run.
  - `total_revenue` went from 2.30 to 3.60 NEAR. That is +1.30, exactly the jobs newly Paid (2, 3, 4, 5, 6, 8, 9: 0.15 + 0.2 + 0.2 + 0.25 + 0.15 + 0.2 + 0.15). The industry revenues also sum to 3.60, and `withdrawn` is 0.
  - Escrow after the run is 0.
  - Contract balance: +0.950000 NEAR, exactly the new deposits (1.10) minus the cancel refund (0.15).
  - Client balance: −0.951892 NEAR, which is −1.10 + 0.15 − 0.001892 in fees.
  - Worker balance: −0.002502 NEAR, which equals the allowance used (0.998627 → 0.996125).
  - Industries: beauty paid 5→8, real-estate 2→3, food 0→2, fitness 1→2. Estimated cost (`spent`) rose by each delivered job's pack ceiling.
  - `delivered_today` reached 9, within the limit of 10.
- **Known small issue.** The worker's local state still shows job 5 as "delivered", because the owner's ruling paid it rather than a finalize. This is harmless, since finalization scans the chain, but the local state is stale for jobs settled by a ruling.

## Live failover check (2026-11-04, autopilot paused, no transactions)
- `NEAR_RPC_URL=https://broken-rpc.invalid node --env-file=.env agent/worker.mjs --once` made 1 retry and 1 endpoint switch, then read `paused: true` from the fallback. Nothing was sent.
- With `NEAR_RPC_URL=https://rpc.testnet.near.org` as primary, the old endpoint answered normally this time, so there was no switch. It remains out of the defaults.
- The worker now syncs local state for jobs settled without its own finalize: a job in Disputed becomes `disputed`, a Paid job settled by an owner ruling becomes `settled`, and a Refunded job becomes `closed`. Job 5's stale local entry will be synced on the first pass after unpausing.
