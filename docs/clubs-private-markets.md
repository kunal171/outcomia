# Clubs and private markets (Solana design)

Status: binary clubs are implemented in the program and the app (milestones
1–5); indexer replay of club trades and multi-outcome club markets are not
yet. The app keeps clubs behind `NEXT_PUBLIC_CLUBS_ENABLED` until the program
is deployed. This document records the product
decisions and the on-chain model they imply. Implementation follows in small
PRs (see [delivery plan](#delivery-plan)). The Canton note in
`outcomia-canton/docs/clubs-private-markets.md` covers the same feature for
Canton; the rules below agree with it where they overlap.

"Private" means **restricted participation**, not confidential data: club
accounts, orders and trades remain publicly readable on Solana. Hiding a market
in the app is never a permission check; the program enforces membership.

## Decisions

| Topic | Decision |
| --- | --- |
| Creating a club | Any wallet, paying the club account rent. The creator becomes its **owner**. Club roles never grant protocol-admin authority. |
| Roles | **Owner** adds/removes admins and transfers ownership. **Admins** manage invitations, members and markets. Any member (or admin) may leave; the owner must transfer ownership first. |
| Joining | An admin **invites** a wallet; the wallet **accepts** by signing. Invitations expire after **7 days**; admins can revoke earlier; anyone can close an expired invitation to return its rent to the inviter. |
| Creating club markets | Per-club policy, **admins only** (default) or **any member**, changeable by club admins. |
| Who trades | Per market: **members-only** (placement and every fill check membership) or **public** (anyone trades; the club curates and resolves). |
| Removed member's resting orders | **Cannot fill**, and **anyone may cancel** them (locked funds return to the owner), so a departed member cannot jam the book. |
| Exits | Cancel, withdraw, merge complete sets and redeem stay available to every holder, member or not. |
| Splitting sets in members-only markets | **Members only** (an entry action). Merge and redemption stay open. |
| Resolver | Any **current club admin** may propose or correct, with the same windows, review delay and per-phase correction deadline as other markets. Finalization stays permissionless. |
| Fees | Traders pay the normal protocol taker fee. A **protocol-wide club share** (set by the super-admin, capped) of that fee accrues to the club; only the **club owner** withdraws it. |
| First scope | **Binary** shared markets. Multi-outcome club markets follow with the same membership checks. |

## Why club markets get their own namespace

Existing instructions (split/merge, place/match/cancel, propose/advance/redeem)
locate a market and its book by PDA seeds and cannot tell whether it belongs to
a club. If a club market used the normal seeds, a non-member could still split,
trade or resolve through those public instructions, and the market and book
layouts are deployed, so they cannot gain a club field.

Club markets therefore use distinct seeds:

```text
prediction market   ["club_prediction_market", market_id]
shared book         ["club_book", market]
```

Existing instructions derive the old seeds, so they **cannot operate on club
markets at all**. Club instructions accept the club seeds, perform the club
checks, and reuse the existing account types and tested logic (custody,
matching, complement, resolution, redemption) through shared functions rather
than copies. Public club markets use the same namespace with membership checks
switched off, so club fees and club resolution apply uniformly.

## Accounts

| Account | PDA seeds | Contents |
| --- | --- | --- |
| `Club` | `["club", club_id]` | owner, name (≤64 bytes), market policy, admin/member counts, created-at, bump |
| `ClubMember` | `["club_member", club, wallet]` | club, wallet, role (`Admin` or `Member`), joined-at, bump. Exists only while active; removal or leaving closes it and returns rent to the wallet |
| `ClubInvite` | `["club_invite", club, wallet]` | club, wallet, inviter, expires-at, bump. Rent paid by the inviter and returned when accepted, revoked or expired |
| `ClubMarket` | `["club_market", market]` | club, market, access (`MembersOnly` or `Public`), creator, accrued club fees, bump |
| `ClubFeeConfig` | `["club_fee_config"]` | club share of the taker fee in bps (capped at 5,000 = 50%), bump. Super-admin only |

Membership is proven by passing the `ClubMember` PDA: an initialized account
for that club and wallet is a member; the derived address being empty is proof
of non-membership (used by permissionless cancellation). The owner is recorded
in `Club` and is always an admin.

## Instructions

**Club administration** (implemented): `create_club`, `set_club_market_policy`,
`invite_club_member`, `accept_club_invite`, `close_club_invite` (any club admin
revokes, the invited wallet declines, anyone clears an expired invitation; rent
always returns to the inviter), `set_club_member_role` (owner promotes or
demotes admins), `remove_club_member` (admins remove members; only the owner
removes admins), `leave_club`, and the two-step `nominate_club_owner` /
`accept_club_ownership` (nominating the owner itself cancels; the previous
owner stays an admin). An invitation belongs to the club, so it stays valid if
its inviter later stops being an admin. A nomination ends when the nominee
leaves or is removed. These instructions emit no events: the accounts are the
record, and the IDL-driven indexer decodes them.

**Club markets (binary first, implemented):** `create_club_prediction_market`
(creator must be an admin, or a member under the any-member policy; access chosen
per market; no fallback, and the stored resolver records the creator only),
`open_club_prediction_market` and `close_club_trading` (club admins, or the
creator while still a member), `initialize_club_position` (anyone, so former
members and public traders can always hold and exit). Club markets get a vault
and metadata but no legacy per-market book or fee record; they trade only on
club books (`initialize_club_book`, milestone 4).

**Custody** (implemented): `club_complete_set` (split requires current
membership in members-only markets; merge never does) and
`redeem_club_prediction` (never requires membership). Both reuse the public
shared custody code through `shared_prediction::Custody`.

**Trading** (implemented): `initialize_club_book` (club admin or the
creator-member) creates a shared-layout book at `["club_book", market]`;
orders and levels use the shared order/level seeds under that book's address,
so they never mix with public queues. `place_club_order` requires current
membership in members-only markets. `match_club_order` and
`match_club_complement` require both taker and maker to be current members in
members-only markets, so a removed member's resting order cannot fill.
`cancel_club_order` lets the owner always cancel, and anyone cancel once the
owner has left a members-only market (the order owner's membership PDA must be
empty); funds and level rent always return to the owner. All of these reuse
the public placement, cancellation and fill code (`place_order`,
`cancel_order`, `match_order`, `match_complement`) after the club checks.

**Resolution** (implemented): `propose_club_prediction` (any current club
admin, under the published window, review delay and correction deadline) and
`advance_club_prediction` (permissionless freeze at cutoff and finalization;
the fallback actions always fail because club markets have none).

**Fees** (implemented): `set_club_fee_share` (super-admin),
`withdraw_club_fees` (club owner, from one club market's accrued share) and
`withdraw_club_book_fees` (super-admin, the protocol's share from a club book;
the public fee withdrawal cannot reach club books). The share is stored in
`ClubFeeConfig`, created on first use; until then it is zero. Club fills read
the config at its canonical address, so a taker cannot omit it.
`split_club_fee` divides each fee: the club part rounds down, so the protocol
keeps any fractional atom and the parts always sum to the fee the trader paid.
A share change applies only to later fills. Both parts stay in the global asset
vault until withdrawn, so

```text
global vault = Σ free + locked claims + Σ book fees + Σ club fees
```

## Invariants to test

- No club market can be reached through a non-club instruction.
- A non-member cannot place, fill, split or (in members-only markets) take
  through a complement; member-only checks hold for both legs of every fill.
- Removal blocks new fills immediately; anyone can cancel the removed member's
  orders, and funds always return to the order owner.
- Exits (cancel, withdraw, merge, redeem) never require membership.
- Club roles grant no protocol-admin power, and protocol admins gain no club
  power from their protocol role. Club instructions accept no protocol
  accounts, and protocol instructions accept no club accounts.
- Fee split conserves the global vault; only the owner withdraws club fees.
- Invitations expire after 7 days, accept exactly once, and return rent to the
  inviter; the owner cannot leave or be removed without transferring ownership.

## Delivery plan

1. **Clubs and membership** (done): accounts, roles, invitations, leaving,
   removal, ownership transfer; `programs/outcomia/tests/clubs.rs`.
2. **Club fee configuration** (done): `ClubFeeConfig`, its super-admin setter
   and the fee split.
3. **Club binary markets** (done): club namespace creation, opening, closing,
   positions, complete sets, resolution and redemption;
   `programs/outcomia/tests/club_markets.rs`.
4. **Club books and trading** (done): membership-checked placement, matching,
   complement fills, cancellation (including permissionless non-member
   cancellation), fee split and withdrawals.
5. **App** (done): see [App](#app).
6. **Indexer:** club accounts and club-book trade replay.
7. **Multi-outcome club markets.**

## App

- **Pages:** `/clubs` (your clubs, invitations to accept, decline or clear,
  club creation), `/clubs/[club]` (markets, members and, by role, invitations,
  revocation, admin promotion, removal, the market policy, ownership transfer,
  leaving and the owner's fee withdrawal), `/clubs/[club]/markets/new` (the
  shared rules-upload creation flow with an access choice; create, open and
  book in one transaction) and `/clubs/[club]/markets/[market]` (trading,
  positions, exits and resolution).
- **Trading:** `lib/shared.ts` takes an optional club context, so club books
  use the same planner and cancellation code with the club instructions and
  membership accounts. In members-only markets the planner refuses outsiders
  and stops at a departed member's head order, and the orders view offers to
  clear such orders (anyone may; funds return to the owner).
- **Discovery:** club markets share the `PredictionMarket` layout, so public
  lists include only markets at the public seed (`isPublicPredictionMarket`),
  a public detail URL for a club market points to its club page, the wallet
  catalog accepts club markets, and the orders page reads and cancels club
  orders on their club book. Hiding a market is never a permission check.
- **Checks:** `npm run test:clubs` (addresses, rules, encodings, packet size),
  club cases in `npm run test:shared`, and
  `node scripts/local-club-e2e.mjs` against a local validator (club, invites,
  members-only market, fills with the fee split, removal and clearing,
  resolution, redemption by a former member, fee withdrawal).

## Deployment notes

- The IDL-driven indexer decodes club accounts and instructions once
  `app/idl/outcomia.json` is synced, which each milestone does.
- The indexer decodes club instructions but does not yet replay club fills
  into trade history (milestone 6).
- The program grows with each milestone. After milestone 4 the SBF binary is
  2,229,320 bytes against the 1,816,760 bytes allocated on devnet, so the next
  upgrade must extend ProgramData by about 413 KB (roughly 2.9 SOL of rent).
- Club books have no close instruction yet; a drained book simply stays.
