# Remit — pre-build checks

Checked 2026-11-04 (UTC). This is a simulated testnet demo: no real money and no real VND.

## 1. Hackathon rules

Source: https://nearhackathon.com/HACKATHON.md (read 2026-11-04)

- **Track id for Real-World Money: `realworld`.** "Build payroll, invoicing, remittances, merchant payments and stablecoin rails for real businesses." Hints: stablecoins, NEAR Intents, meta transactions.
- **Submission rules:**
  - Each project submits once. A repository can be submitted only once. Submissions cannot be edited.
  - The submission can list several tracks.
  - The window runs 2026-11-01T00:00Z to 2026-11-14T23:59Z.
  - The repository must be public by then. A demo post on X is required (video, or screenshots).
- **Existing projects:**
  - Q-001: code written from the announcement on 2026-10-19 counts. Earlier commits are baseline.
  - Q-003 and Q-004: an old project as-is is not eligible. A new feature built in the window is eligible if it is kept separate, either on a dedicated branch or by tagging `pre-hackathon` and `hackathon-submission`, with a README section that links the diff.
  - AllTrades' first commit is 2026-11-02, so the whole repo falls inside the window. Remit is built on the `feature/remit` branch.
- **Intents:**
  - Q-006: a 1Click JWT is not required.
  - Q-007: there is no Intents testnet. Use mainnet with dev accounts and tiny amounts, or `dry: true` quotes.
  - Q-010 and Q-011: testnet-only projects are eligible for every track. A project's own contract that fits the track is enough.

## 2. NEAR Intents 1Click — dry quote

Sources:
- https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md
- https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md
- https://docs.near-intents.org/security-compliance/terms-of-service.md

- **A JWT is not required.** Two `POST https://1click.chaindefuser.com/v0/quote` calls with `"dry": true` and no `X-API-Key` both returned **HTTP 201**. Neither response contained a `depositAddress`, so nothing could be deposited.
  - 10 USDC → USDT, both on NEAR (`EXACT_INPUT`, slippage 100 bps).
  - 1 wNEAR → USDC on NEAR.
- **Response fields:**
  - `quote` contains: `amountIn`, `amountInFormatted`, `amountInUsd`, `minAmountIn`, `amountOut`, `amountOutFormatted`, `amountOutUsd`, `minAmountOut`, `timeEstimate`, `refundFee`, `withdrawFee`.
  - The top level also has `quoteRequest`, `signature`, `timestamp` and `correlationId`.
- **Required request fields:** `dry`, `swapType`, `slippageTolerance`, `originAsset`, `depositType`, `destinationAsset`, `amount`, `refundTo`, `refundType`, `recipient`, `recipientType`, `deadline`.
  - We used the all-zero implicit account as recipient and refundTo, so no real person's address was involved.
- **Fee without a JWT:** the docs say an extra **0.25%** on non-`ANY_INPUT` quotes. HACKATHON.md Q-006 says 0.2%. The two sources disagree; treat the Intents docs as current.
- **Not done:** no token was sent, `/v0/deposit/submit` was not called, and no swap was executed.
- **Terms to respect:**
  - §(e): API data may not be cached or stored for more than 24 hours, except for transaction history. We therefore keep no quote amounts in this repo.
  - §(f) and §(g): developers must run KYC/AML and sanctions screening on their end users. A real remittance product would need this. The demo has no real users.
  - The service says it is not a money transmitter or payment service provider.
- **No VND:** 1Click quotes crypto assets only (USDC, USDT, wNEAR and others). It does not quote fiat VND.

## 3. USD → VND comparison data

No scraping was done. Each source below was checked for a public API and for terms of use.

| Source | Access | Terms | Usable for the demo? |
|---|---|---|---|
| World Bank, Remittance Prices Worldwide | Excel download, plus an API via DataBank | CC BY 4.0. Attribution text: "The World Bank, Remittance Prices Worldwide, available at http://remittanceprices.worldbank.org". Do not imply endorsement. | **Yes, recommended.** It is quarterly and runs through Q3 2025, so it is a reference cost for the corridor, not a live price. |
| ExchangeRate-API open access (`open.er-api.com/v6/latest/USD`) | Public, no key. Returned HTTP 200 with a VND rate. | Pages that show the rates must carry the attribution "Rates By Exchange Rate API". Updated once a day. Caching is allowed. Redistribution is not. Rate-limited per IP. | **Yes, for a mid-market reference rate.** Show the attribution and do not commit the raw data. |
| Wise Comparison API (`api.wise.com/v4/comparisons`) | One unauthenticated GET returned 200 with 6 providers. | The docs say "All requests to the Comparison API require authentication" and that the data "must not be used for critical flows". | **No.** It would need Wise's approval. The response was not kept. |

Sources:
- https://datacatalog.worldbank.org/search/dataset/0037898/remittance-prices-worldwide
- https://remittanceprices.worldbank.org (its dataset terms page returned 403 to our fetch, so we have not read it)
- https://www.exchangerate-api.com/docs/free and https://www.exchangerate-api.com/terms
- https://docs.wise.com/api-reference/comparison

## 4. What this means for the build

- The contract holds testnet NEAR in a `TransferOrder`. A simulated payout account settles it, or the sender takes a refund after the deadline.
- No real VND moves. The payout partner is simulated.
- Off-chain, a dry 1Click quote can show what the stablecoin leg would cost. The World Bank figure for the corridor and an attributed mid-market rate can give context.
- Recipient details stay off-chain. Only a salted SHA-256 hash is stored.

## 5. Transfer safety and known limits (added 2026-11-04)

- **Minimum order: 0.01 NEAR** (`MIN_ORDER_AMOUNT` constant). The contract pays each order's storage, so dust orders are refused. The owner's cap cannot be set below this minimum.
- **Two-step transfers.**
  - `settle_order` moves the order to `Settling`, and `refund_order` moves it to `Refunding`. Each then sends the NEAR and schedules the private callback `on_order_transfer`.
  - On success, the callback marks the order `Settled` or `Refunded`.
  - On failure, for example when the receiving account no longer exists, NEAR returns the transfer to the contract and the callback puts the order back to `Open`. The deposit is not lost. The payout account can retry before the deadline, and the sender can refund after it.
  - While an order is `Settling` or `Refunding`, any settle or refund call is rejected with "Order has a transfer in progress".
  - The callback can only be called by the contract itself: `#[private]`, plus the same check in the method body.
- **`refund_job` is unchanged and still has the old weakness.** It marks the job `Refunded` before its transfer. If that transfer fails, the NEAR returns to the contract, but the job stays `Refunded` and is counted in neither revenue nor any open job. It can then only be recovered by a contract upgrade. This change applies to Remit orders only.
- **Callback gas.** The callback is given 10 Tgas. Call `settle_order` and `refund_order` with at least 50 Tgas. If the callback runs out of gas, the order stays `Settling` or `Refunding` and no method can recover it. A future fix could add an owner-only `resolve_stuck_order`. That has not been built.

## 6. Testnet deployment log

All on testnet. Explorer links: https://testnet.nearblocks.io/txns/<hash>

**2026-11-04: first Remit deploy** (callback-confirmed settle and refund)
- Before the deploy, the wasm running on chain was `AwkZQUbz…3GpN`. It was backed up locally and matched the on-chain `code_hash`.
- The deployed wasm is `BjALTWgb4tp7BU6zHqS3M8cS4CV84TX5n12Z9FZC9LyM`. The `code_hash` matched after the deploy (tx `4m8TPa1XedV2pg75FrjPhcceAKFF8bx6wu8H8g3PusWv`).
- `get_industries` and `get_job` 0–11 were byte-identical before and after.
- Config: `set_remit_config` set payout to `payout-long2222.testnet` and the cap to 0.5 NEAR (tx `EWu9F3ymS77vhGmN7MuNxQCaqoqFAyUvwynVr2yxwZye`).
- Order 0 (0.1 NEAR): created in tx `4zJ741GHeUiQEnrc51TnC54FUeewsP9GeQ3zDZFyLqma`, settled in tx `FAJWHD9LU4vW2dL157iStTxHHCPvUPo7FwSCGPuTfv1n`.
  - The transfer receipt sent 0.1 NEAR to payout, and `on_order_transfer` returned `"Settled"`.
  - Total gas was 4.96 Tgas.
- Order 1 (0.05 NEAR, 60 s): created in tx `DCvWSn6RSz62ArErDkfcbHW8qqG5hDJngLr7Wtxuqxid`.
  - A late settle was rejected with "Order deadline has passed". near-cli printed no hash for the failed tx.
  - The refund went through in tx `GXsjkt8bmZCD5YSS4RNSaiBrgWuzPx3XmjekPA9By7vZ`: 0.05 NEAR returned to the client, and the callback returned `"Refunded"`.

**2026-11-04: gas floor deploy**
- The deployed wasm is `8yKJM736evgs1P5RWWKhmNEZ5DH77PA7QQLTVPV3HuYe`. The `code_hash` matched (tx `Axo39CsMAm655Eo1JtpzeJansABfRh1gx37m166ZZ7Vg`).
- `get_industries`, `get_job` 0–11, `get_remit_config` and `get_order` 0–1 were byte-identical before and after.
- Order 2 (0.02 NEAR) was created in tx `6fyVbhxF5pPRb8JDuLWVsryZbcjDaWPJvNGkouC53D1f`.
- **19.999 Tgas was rejected:** tx `3aTZQXNs5B3KDJQTCttnqnpFAgMppnuB1Z4xvXR3wraA`.
  - The prepaid gas was exactly `19999000000000`. near-cli displays it as "20.0 Tgas", so we decoded the signed transaction to check the real value.
  - The receipt failed with "Smart contract panicked: Attach at least 20 Tgas", and order 2 stayed `Open`.
- **Exactly 20 Tgas was accepted:** tx `HqZ7kjWv6GtCxcc2GDVHdt4axcWx3ifob8asTDTGGoqg`, with prepaid gas `20000000000000`.
  - The transfer sent 0.02 NEAR to payout, and the callback returned `"Settled"`.
  - Total gas burnt was 4.97 Tgas.

**2026-11-04: payout script on chain**
- Order 3 (0.03 NEAR) was created in tx `BBiYquMxJr64bSEedUxPyEzPKUGa3x44gaNNvwavMZFi`.
- `node agent/payout/settle.mjs 3` ran these steps in order:
  1. Read the order (`Open`).
  2. `MockPayoutProvider.deliver` returned `delivered` (`mock-1`, simulated).
  3. `settle_order` with 30 Tgas, tx `EgJeTVKwDjeVpuQBv2yCbY2hXwDVeS4BZsPQRhX3sFmw`.
- The transfer receipt sent 0.03 NEAR to payout, and `on_order_transfer` returned `"Settled"`.

**2026-11-04: README "Run it yourself" check from a fresh clone** (no `.env`, `notes/`, `backups/` or `.agent-state.json`)
- In the clone, `npm install` and `npm test` passed 90/90, and `cargo test` passed 82/82.
- `cargo near build` produced the same wasm `8yKJM736…HuYe`.
- Step 9 (live draft) printed a working `sign_command`.
- Step 10: the sender signed order 4 in tx `A4vtNJz9XFQMZ8zsjmTbYWvJ2wKmvyBhFpAYQWa16d4m`.
- Step 11: `settle.mjs 4 --contract … --payout …` sent tx `CoUcAWV1ye5jqwZHts6JL77cCACqPthgvfCyoX38SY7n`. The transfer was 0.05 NEAR and the callback returned `"Settled"`.
- Step 12: the clone's dashboard showed order #4 as settled.
- Steps 7–8 were not re-run, because the payout account and config already exist. The same commands ran earlier, in tx `6WsJAAVQ…` and `EWu9F3ym…`.

## Demo video take (2026-11-05 UTC)
- Draft from `node agent/remit.mjs --fixtures "Gửi 500 đô về cho mẹ"`; the withdraw injection was refused.
- Order 5 (0.05 NEAR): the sender signed `create_order` (`FSvrPTjKcLZ6krUe26cKhRMjJqSyrPGAX4rgp3EkaQY`); `agent/payout/settle.mjs 5` settled it after the mock delivered (`35Xh16P61dKqS2NsNQLRXN5XjA24tiRB7zrT4GDKPqEY`).
