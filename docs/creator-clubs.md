# Outcomia Creator Clubs

**Status: planned.** This document is the shared product specification. It is
implemented separately in `outcomia-canton` (Daml) and in the Solana program
(Anchor), with each step shipping its contract and UI together.

Creator Clubs turn clubs into a creator economy for prediction markets.
Verified community operators run discoverable communities around an interest,
create markets for their members, and earn a protocol-enforced share of trading
fees. For example, an independent FC Barcelona fan community could be found by
anyone, accept membership requests, and run markets for its members.

Creator Clubs is one Outcomia product with two chain implementations, not two
products.

```
                 Outcomia club registry (off-chain)
     discovery · operator verification status · policies · branding
                 ┌───────────────┴────────────────┐
        Canton (outcomia-canton)           Solana (Anchor program)
  Daml club contracts, membership,     Club and membership PDAs, stake
  stake custody, fee distribution      vault, fee distribution
        indexed by CantonGrid            indexed by the Solana indexer
```

## Club types

| Type | Discovery | Membership | Today |
| --- | --- | --- | --- |
| Private | Invite-only, not listed | Invitation required | Shipped on Solana; Canton Phase C |
| Public | Listed for everyone | Request, then operator or moderator approval | Planned |
| Open | Listed for everyone | Anyone eligible joins directly | Planned |

A club's type can change from Private to Public or Open only after it meets the
operator requirements below. Existing members keep their membership when the
type changes.

## Roles

- **Operator** (club owner): manages the club and receives the club's fee
  share. Must be verified and staked for Public and Open clubs.
- **Moderators** (club admins): approve requests, remove members and create
  markets under the club's market policy. They never control funds.
- **Members**: trade in members-only club markets.

Club roles never grant protocol authority, never move members' funds and never
decide market outcomes.

## Membership

- **Private:** invitation, accept or decline (existing flow).
- **Public:** a wallet files a request with an optional note. The operator or a
  moderator approves or rejects it. Requests expire after a fixed period, and
  rejected wallets may request again after a cooldown.
- **Open:** a wallet joins directly if it passes the club's eligibility rules
  (for example, jurisdiction or a verification level).

Membership is checked against the current roster on every entry action:
placing an order, splitting and both sides of each fill. Exits never check
membership, so departed members can always cancel, merge and redeem.

## Operator verification (KYC)

Public and Open clubs need an operator verified by an approved verification
provider.

- The chain stores only an **attestation**: provider, subject (party or wallet),
  verification level, issue time and expiry. It never stores identity documents
  or personal data.
- **Canton:** an attestation contract signed by the provider's party; the club
  references it, and the eligibility check fails once it expires or is revoked.
- **Solana:** an attestation account written by an approved provider signer (or
  an ed25519-verified provider message); expiry and revocation are checked on
  instructions that need it.
- An expired or revoked attestation pauses new market creation and new
  memberships. Trading in existing markets and all exits continue.

Verification is necessary for a public club, but it does not establish legal
compliance on its own (see Legal).

## Operator stake

Public and Open clubs lock a stake that sets an economic commitment.

- The minimum stake depends on the club's tier (for example, by member count
  or monthly volume), and the tier rules are published.
- **Canton:** stake is held in an authorized custody contract, using the same
  holding and vault pattern as market collateral.
- **Solana:** stake is held in a program-controlled token vault PDA.
- Withdrawing starts an **unbonding period**. The club leaves Public/Open
  status at the start of unbonding, not at the end.
- **Slashing** only follows proven misconduct under narrowly defined rules,
  such as fee manipulation, wash trading or misleading market terms. A finding
  requires an independently reviewable process: published evidence, a response
  window, a decision by a review body that excludes the operator and the
  complaining parties, and an appeal window. Neither Outcomia nor members can
  slash unilaterally. Slashed funds go to affected members first.

## Fee sharing

Trading fees stay a single combined taker fee, split between Outcomia and the
club. As an illustration, on a $1,000 trade with a 0.30% fee:

| Recipient | Share | Amount |
| --- | --- | --- |
| Outcomia platform | 0.20% | $2.00 |
| Club operator | 0.10% | $1.00 |
| Total taker fee | 0.30% | $3.00 |

- The total fee, the platform allocation and the club allocation are shown
  before every trade.
- The split is applied **atomically with settlement**, in the same matching
  instruction or Daml choice. It uses the same precision, rounding direction
  and cumulative-fee safeguards as today's trading fees.
- The club share accrues to a per-club fee balance that only the operator can
  withdraw.
- The club share has a protocol cap. Fee changes are timelocked and announced
  before they apply, and an order always settles at the fee terms it was placed
  with (the existing expected-fee-revision check).
- **No self-dealing revenue:** fills where the operator or a moderator is on
  either side do not earn the club share. Self-matching is rejected as it is
  today.

## Market resolution

Operators must not decide outcomes of markets they earn fees from.

- Club markets use an independent resolver: the protocol resolver set or a
  verifiable oracle. The operator and moderators cannot be the resolver or the
  fallback resolver.
- The existing review period and correction window apply unchanged.

## Discovery, branding and privacy

- The **Outcomia club registry** (off-chain) holds the listing: name,
  description, logo, topic, type, verification status and links to the chain
  instances. The chain remains the source of truth for membership, stake and
  fees, and the registry only mirrors it.
- Communities based on teams, brands or people are labeled **"Independent fan
  community"** unless an official affiliation has been verified.
- **Canton:** making every member an observer of every market is expensive and
  discloses more than necessary. Club markets use selective visibility: market
  data is disclosed to current members through a member-scoped disclosure
  service, as planned for Canton Phase E.
- **Solana:** account data is public. The app makes this clear when a user
  joins a club, and private clubs give access control, not confidentiality.
- **Indexing:** CantonGrid indexes Canton memberships, factory creations and
  earnings. The Solana indexer provides the same views for Solana.

## Same club on both chains

A community may run instances on both chains under one brand. Each instance has
its own memberships, stake, fee balance, positions and order books. The app
shows them together under one club page, but liquidity and collateral never
move between chains automatically. Cross-chain transfers or synchronized
trading would be separate, much larger features.

## Safeguards

- **Wash trading:** self-trade rejection, no club revenue on operator or
  moderator fills, and volume reports that exclude related wallets.
- **Market creation abuse:** per-club creation limits, market terms validation
  and a report flow that can pause a club's new markets pending review.
- **Misleading promotion:** listing guidelines, non-affiliation labels and the
  slashing process above.
- **Funds:** operators can never seize members' funds, change a market's terms
  after trading opens, or block exits.

## Legal

Real-money prediction markets and revenue sharing need jurisdiction-specific
legal review before Public or Open clubs launch. KYC alone does not establish
regulatory compliance. Eligibility rules (for example, jurisdiction
restrictions) must be enforceable per club and per market.

## Delivery plan

Each step ships contracts and UI together on each chain, and the Canton and
Solana implementations may land at different times.

| Step | Contracts | UI |
| --- | --- | --- |
| CC0 | This specification | Landing page mention ("coming soon") |
| CC1 | Public (request/approve) and Open (join) club types | Club discovery list, request and approval flows |
| CC2 | Registry sync and indexing (CantonGrid, Solana indexer) | Club search, topics, cross-chain club page |
| CC3 | Fee split in settlement, club fee balance, withdrawal | Fee breakdown before trading; operator earnings |
| CC4 | Operator attestations and stake with unbonding | Operator onboarding, verification and stake screens |
| CC5 | Misconduct review and slashing | Report, evidence, decision and appeal views |
| CC6 | Hardening, audits, legal gating per jurisdiction | Eligibility notices and launch controls |

On Canton, CC1 builds on the Phase C roster model, and member-scoped disclosure
(Phase E) is a prerequisite for CC2.

## Open questions

- Which verification providers to approve first, and which attestation format
  they can sign.
- Stake tiers, minimums and the unbonding period.
- Composition of the misconduct review body.
- The default fee split and the cap on the club share.
- Whether Open clubs need any verification level for members.
