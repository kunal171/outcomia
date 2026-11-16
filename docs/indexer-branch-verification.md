# Indexer branch verification

Branch: `feature/indexer-ui-improvements`  
Checked: 2026-11-16  
Verdict: the implemented local foundation passes its checks; the full proposed
indexer/API roadmap is **not** complete and deployment readiness is unproven.

## Automatic fallback follow-up

Automatic fallback and recovery have since been added for current account/book
reads, raw account batches and wallet holdings. Scoped cooldowns prevent repeated
requests to an unhealthy indexed dataset. Navigation aborts remain cancellations.
Guarded transaction receipts may use RPC confirmation of the existing signature;
no transaction is resent. Source labels and refreshes automatically return to
GraphQL after recovery. Historical charts and login retain their indexer dependency.
The original audit evidence below describes the preceding verification pass;
current fallback behavior is documented in the indexer README. The follow-up
checks pass: 15 frontend indexer/receipt/fallback regressions, 83 ordinary Rust
tests, strict Clippy and the real browser/API/database flow. The browser verifies
HTTP 503 and stale-data fallback, actual RPC wallet/book reads, automatic
GraphQL recovery, zero healthy-mode RPC reads and preserved trade quantity.

## Deposit-based onboarding follow-up

Connected-wallet access now stays available during authentication outages. No
message signature is requested or queued while auth is unavailable. Finalized
balance/position sources and available backfilled deposit history create an
unverified user record and start tracking, without creating a session or writing
balances. Later signature verification upgrades the same profile ID. Recovery
checks existing sessions only and does not automatically open a wallet prompt.

## Implemented and checked locally

- Modular Rust ingestion, processing, storage and GraphQL resolvers; frontend
  GraphQL transport and domain operations with indented multiline queries.
- All 23 IDL account layouts, 30 event types, exact integer hydration and source
  replay checks. Confirmed/finalized account revisions remain separate.
- Database-backed GraphQL account reads, filtered/cursor-paginated account pages,
  revision streams, latest trades, receipts, holdings and bounded finalized OHLCV.
- First-login message signature, single-use expiring challenge, origin/network/
  wallet binding, hashed sessions, session reuse and logout revocation.
- Protocol balances stay chain projections; verified users only establish profile
  and tracking relationships. Shared holdings ingestion serves SOL/SPL balances.
- Indexed frontend read adapters and revision-driven panel updates preserve trade
  drafts. Signing/preflight/confirmation retain targeted RPC reads.
- Candlestick, OHLC bar, line and area charts, optional volume, outcome/interval/
  range selection, accessible exact data and mobile layout.
- Existing smoke-market hiding remains in discovery UI; hidden accounts remain
  reachable through direct-address and recovery paths.

## Findings fixed during this audit

1. Pending indexed receipts were only held in memory. They now survive reloads
   through session storage, remain isolated by wallet, and report failed receipts
   accurately. One provider-level guard covers every wallet-backed program send,
   including legacy, funding and settlement actions; concurrent forms cannot
   bypass it.
2. Shared funds did not subscribe to indexed balance revisions. They now refresh
   through the shared stream without clearing the amount draft.
3. Unaligned chart ranges could intersect 2001 buckets while passing the old
   duration check. Bounds now count intersected buckets and reject truncation.
4. Late source transactions behind the execution cursor could leave later fills
   calculated with the old fee. Per-instruction application state now triggers
   an atomic reset and deterministic rebuild of instruction-derived projections.
   Event-derived trades remain intact; replay stays idempotent.
5. Chart-worker freshness alone could label history complete while source recovery
   stalled. A separate history sync marker now gates complete coverage. Missing
   decode/order/application state blocks shared/binary history; enriched source
   positions also repair previously projected event trades.

## Evidence

The checks below ran locally after the relevant changes. No production or devnet
transaction was submitted.

| Check | Result |
| --- | --- |
| Rust formatting and strict Clippy, all targets | Passed |
| Ordinary Rust tests | 82 passed; database tests run separately |
| PostgreSQL integration suite with browser fixture enabled | 15 passed, including the real browser/API/database flow |
| Anchor wire fixtures | All 23 account layouts agree |
| Frontend indexed read, hydration and receipt regressions | 7 passed |
| Prediction, shared trading, wallet, multi-outcome, RPC proxy, i18n, theme and Canton regression scripts | Passed |
| Frontend type checking and IDL agreement | Passed |
| Production build with indexed reads enabled | Passed |
| Production build with indexed reads disabled | Passed |
| Docker Compose configuration | Passed; an image build was not performed |

The browser fixture uses a real Next proxy, Rust API and migrated isolated
PostgreSQL database, with a local fake Solana upstream. It verifies first-login
signing, session reuse, four chart views, empty intervals, committed live balance
updates, preserved order quantity, wallet holdings, logout, mobile width and no
browser Solana RPC reads on the exercised multi-outcome/wallet routes. It does
not establish live-chain performance or full spot/binary transaction coverage.

## Still open from the broader design

- Joined, strongly typed market/book/wallet GraphQL responses and revision
  consistency across a whole composed screen. Current queries expose typed
  account envelopes with IDL-shaped JSON, and the frontend assembles views.
- Server-side market discovery/search/visibility filtering and its pagination.
  Smoke-market hiding currently remains a frontend policy.
- Paginated trade/activity APIs and verified rules/evidence document caching.
- Provisional candles, depth charts, market-stat summaries, P&L and USD valuation.
  The implemented chart views share finalized OHLCV, not these other datasets.
- Real provider/archive coverage, sustained ingestion/RPC cost and read-to-render
  latency/load measurements, broader spot/binary browser fixtures and container
  image validation.
- Indexer/database hosting and frontend activation: configure the API URL/origin,
  apply migrations, validate runtime program/IDL alignment and history coverage,
  then enable the frontend build flag. The flag still defaults to false.

Cross-outcome matching, clubs/private markets and permissionless creation remain
explicitly deferred. A Solana program upgrade and live smoke test were excluded
from this work. This audit does not push, merge, deploy or enable any environment.
