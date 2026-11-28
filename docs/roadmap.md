# Roadmap

Planned work only. Nothing here is built unless it says so. Each item needs its
own design, tests and UI before it counts as done, and before starting one,
settle its permissions, backing, lifecycle and recovery rules.

## Clubs

- **Club rules M4–M6:**
  - **M4:** the $50 penalty for wrong outcomes.
  - **M5:** indexing of deposits, disputes and penalties.
  - **M6:** Canton parity.

  See [clubs](clubs.md#next-penalties-m4).
- **Multi-outcome club markets:** the same membership checks on multi-outcome
  books ([#68](https://github.com/kunal171/outcomia/issues/68)).
- **Creator Clubs** (one product across Solana and Canton). CC1, public and open
  clubs, is live.

  | Step | Contracts | UI |
  | --- | --- | --- |
  | CC2 | Registry sync and indexing | Club search, topics, a club page for both chains |
  | CC3 | Club fee split in settlement (the fee share is live; this adds a fee breakdown and operator earnings) | Fees shown before a trade, operator earnings |
  | CC4 | Operator attestations (KYC) and stake with unbonding | Operator onboarding, verification and stake |
  | CC5 | Misconduct review and slashing | Report, evidence, decision and appeal |
  | CC6 | Hardening, audits, legal gating per jurisdiction | Eligibility notices, launch controls |

  - **Attestations:** chains store only attestations (provider, subject, level,
    expiry), never identity data.
  - **Slashing:** it requires published evidence, a response window, an
    independent review body and an appeal. Slashed funds go to affected members
    first.
  - **No self-dealing:** fills where the operator is on either side earn no club
    share.
  - **Resolution:** operators shouldn't resolve markets they earn fees from.
  - **Open questions:** verification providers, stake tiers, who sits on the
    review body, the default fee split, and member verification for open clubs.

## Markets

- **Creation:**
  - **Permissionless creation:** today an active admin is needed; this would
    allow creation under protocol rules.
  - **Private (invite-only) markets:** outside clubs.
- **Governance:**
  - **Proposals and votes:** members propose markets and vote YES, NO or Abstain,
    with a configurable quorum, period and threshold.
  - **Execution:** an approved proposal is executed by a caller and must be bound
    to the voted parameters, once.
- **Outcomes:**
  - **Several winners:** multi-winner markets need a different payout model.
  - **Switching positions:** sell YES and buy NO in one transaction.
    - **Guard:** a final check on the minimum sold, net proceeds, minimum received
      and maximum extra spend. Any failure rolls everything back.
    - **Remainders:** neither leg posts a remainder.
- **Oracles:** a resolution adapter in place of the trusted resolver, without
  changing positions or books.

## Spot and liquidity research

Ordered phases from the original spot research plan:

1. **Oracle foundation:** Pyth behind a small adapter, with checks on staleness,
   confidence and the feed ID. (Pyth is now used for club deposits.)
2. **Reference prices on market pages:** oracle price and age, spread, depth.
3. **Reference market maker:** an off-chain TypeScript service that quotes around
   the oracle, with inventory limits.
4. **Monitoring:** circuit breakers in the maker (stale oracle, wide spread,
   failure rate), plus dashboards built from indexer data.
5. **Constant-product AMM:**
   - **Design:** separate pool accounts with LP shares and fees, built in small
     feature branches.
   - **Routing:** an off-chain router across the CLOB and the AMM, before any
     on-chain coupling.
6. **Benchmarks:** compute, transaction size, account counts and contention, for
   each component and for hybrid transactions.

## Platform

- **Canton indexing:** a Canton indexer on TestNet, once CantonGrid supports
  remote sources. This unblocks Canton P&L ([profiles](profiles.md)).
