# Clubs and private markets (Solana design)

Status: design agreed; clubs and membership (milestone 1) implemented, club
markets not yet. This document records the product
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

**Club markets (binary first):** `create_club_prediction_market` (creator must be
an admin, or a member under the any-member policy; access chosen per market),
`open_club_market`, `close_club_trading`, `initialize_club_book`.

**Custody and trading:** `club_complete_set` (split requires membership in
members-only markets; merge never does), `place_club_order`,
`match_club_order`, `match_club_complement`, `cancel_club_order` (the owner
always; anyone, when a members-only order's owner is no longer a member).
Every fill in a members-only market checks both taker and maker membership.

**Resolution and claims:** `propose_club_prediction` (any current club admin),
`advance_club_prediction` and `redeem_club_prediction` (permissionless, as
today).

**Fees:** `set_club_fee_share` (super-admin), `withdraw_club_fees` (club owner).
Each club fill splits the taker fee: the club share accrues in `ClubMarket`, the
rest in the book as today. Both remain in the global asset vault, so

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
2. **Club fee configuration:** `ClubFeeConfig` and its super-admin setter.
3. **Club binary markets:** club namespace creation, opening, closing,
   resolution and redemption.
4. **Club books and trading:** membership-checked placement, matching,
   complement fills, cancellation (including permissionless non-member
   cancellation), fee split and owner withdrawal.
5. **App:** club pages (create, invite, accept, members, roles), club market
   creation with access choice, membership-aware trading, private markets
   listed only inside their club, recovery views for former members.
6. **Indexer:** club accounts and club-book trade replay.
7. **Multi-outcome club markets.**
