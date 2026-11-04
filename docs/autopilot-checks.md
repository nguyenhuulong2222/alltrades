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
