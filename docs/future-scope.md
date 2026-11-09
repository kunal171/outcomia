# Prediction platform: future scope

This document records the agreed direction for Outcomia. These are planned
features, not a list of what is available today. Each milestone needs its own
design, implementation, tests and UI before it is considered complete.

The goal is a user-created prediction platform with an on-chain central limit
order book, public and invite-only markets, permanent clubs and governance.

## Current foundation

Outcomia already has binary YES/NO markets, on-chain limit orders, price-time
priority, partial fills, cancellation and atomic settlement. Outcome positions
are backed by one collateral asset per market. Complete pairs can be created
and merged; final resolution permits redemption into the shared asset wallet.

Market creation currently requires an active protocol admin. Permissionless
creation, private trading permissions, clubs, multi-outcome markets, governance
and cross-outcome matching are future work. See
[prediction design](prediction-market-design.md) and
[shared custody and settlement](shared-balances-resolution.md) for the current
implementation.

## Market access and creation

| Feature | Planned behavior |
| --- | --- |
| Public markets | Anyone can discover and participate. Users can create questions under protocol-defined creation rules. |
| Private markets | Invited wallets can discover the market through the frontend and trade. The protocol checks trading permissions. |
| Club markets | A permanent group manages members and creates multiple markets over time. |
| Governance-created markets | Members propose and vote on markets. An approved proposal can be executed to create its agreed market. |

Visibility, creation authority and outcome structure are separate choices. For
example, a club may govern an invite-only binary market. Its access rules do
not change how collateral backs its contracts.

## Prediction types

- **Binary:** YES or NO.
- **Multi-outcome:** several named outcomes, such as five race participants.
- **User-created events:** the creator supplies the question, outcomes,
  deadlines, evidence requirements and resolution rules.

Before adding multi-outcome trading, decide whether exactly one outcome can
win or several can win together. These require different backing and payout
rules. A multi-outcome market is not just a binary market with more buttons.

Published terms must define who resolves the event, when resolution is allowed,
what evidence counts, and any fallback process or deadline. Governance for
market creation does not automatically grant authority to decide its winner.

## On-chain order book

Keep the existing limit buy/sell, FIFO, partial-fill and atomic-settlement model.
Extend it to the new access rules and outcome structures.

Cross-outcome matching should let compatible orders share liquidity through
collateral-backed complete sets. Its exact price conditions, fees, rounding and
payout model need a separate design. It must not create unbacked positions or
bypass order limits, permissions or priority rules.

## Private markets and clubs

Private means restricted participation, not confidential on-chain data. Account
contents, orders and transactions remain publicly inspectable. Hiding a page
is not a trading permission check.

Planned club features:

- wallet invitations and membership records;
- club admins who manage membership and permissions;
- multiple markets within the same group;
- member market creation under the club's configured policy;
- group trading history, leaderboards and prediction accuracy.

Membership changes must never confiscate existing funds or require a club
admin's approval for recovery.

| Action after removal | Required behavior |
| --- | --- |
| Create new exposure | Block new orders and other permissioned entry actions. |
| Cancel owned orders | Remain available. |
| Withdraw free assets | Remain available. |
| Merge owned free complete sets | Remain available where the market lifecycle permits it. |
| Redeem resolved positions | Remain available. |
| Find recovery actions | Provide a limited view of the wallet's own orders and positions, even when normal market discovery is hidden. |

The treatment of resting orders after removal must be decided before private
markets launch: cancellation, matching eligibility and membership changes must
agree on when an order can still fill.

## Governance

Governance should support public communities and private clubs:

- members submit motions or market proposals;
- votes support YES, NO and Abstain;
- quorum, voting period and approval threshold are configurable;
- members can select between competing market proposals;
- an approved proposal creates its market through an execution instruction.

A successful vote does not itself send a Solana transaction. A caller or keeper
executes the approved proposal. The protocol must bind execution to the voted
parameters and prevent duplicate execution.

Define voter eligibility, voting weight, membership snapshots, how abstentions
affect quorum, tie handling, and what happens if the proposed market's deadline
passes before execution. Proposal approval must not let a caller substitute
different rules, resolvers, collateral or outcomes.

## Development approach

Build in small milestones. Explain the account model and tradeoffs before
implementation, then verify the program and UI together.

Before starting each feature, settle its permissions, backing, lifecycle and
recovery rules. Keep proposed features clearly separate from working features
in the UI. Leaderboards and indexed history can help discovery, but indexed
data must never authorize a trade or a payout.

This scope does not replace the separate
[indexing, reference-price and AMM roadmap](future-enhancements.md). Scheduling
and technical choices for those tracks remain separate decisions.
