# Clubs and disputes

Clubs are communities that run their own prediction markets. "Private" means
**restricted participation**, not hidden data. Club accounts, orders and trades
are public on Solana. The program enforces membership; the app hiding a market
is never a permission check.

Canton has the same club model; see
[outcomia-canton `docs/clubs.md`](https://github.com/kunal171/outcomia-canton/blob/main/docs/clubs.md).

## Status

| Feature | Solana |
| --- | --- |
| Clubs, membership, binary club markets, fee share | Live |
| Public listings, join requests, open clubs (CC1) | Live |
| Club rules: types, caps, limits (M1) | Live |
| Security deposits (M2a), switching type, settling, closing (M2b) | Live |
| Outcome disputes on every prediction market (M3) | Live |
| Penalties for wrong club outcomes (M4) | Next |
| Multi-outcome club markets | Not built ([#68](https://github.com/kunal171/outcomia/issues/68)) |

## Roles and membership

- **Owner:** creates the club and pays its rent.
  - **Admins:** promotes and demotes them, and removes admins.
  - **Transfer:** hands over ownership in two steps (`nominate_club_owner`, then
    `accept_club_ownership`). The previous owner stays an admin.
  - **Leaving:** can't leave without transferring ownership first.
- **Admins:** invite and remove members, run club markets and resolve them.
- **Members:** anyone except the owner may leave.
- **Protocol separation:** club roles never grant protocol-admin power, and
  protocol admins get no club power from their role.

How a wallet joins:

| Club type | Joining |
| --- | --- |
| Private | An admin invites the wallet and the wallet accepts. Invitations expire after 7 days, and the rent always goes back to the inviter. |
| Public, request-to-join | The wallet sends a request with an optional note. It lasts 7 days, and an admin approves it. |
| Public, open | `join_open_club` |

**Verified listings.**
- **What a listing holds:** a public club's `ClubListing` holds its join mode, a
  topic and a description.
- **Verification:** a listing admits members and shows in discovery only while a
  protocol admin has verified its current terms.
- **Edits:** any owner edit clears verification.

## Accounts

| Account | Seeds | Holds |
| --- | --- | --- |
| `Club` | `["club", club_id]` | Owner, name, type, market policy, counts, deposit fields, `live_markets`, `closed` |
| `ClubMember` | `["club_member", club, wallet]` | Role; it exists only while the wallet is a member |
| `ClubInvite` | `["club_invite", club, wallet]` | Inviter and expiry |
| `ClubListing` / `ClubJoinRequest` | `["club_listing", club]` / `["club_join_request", club, wallet]` | Public listing and requests |
| `ClubOwnerRecord` | `["club_owner", wallet]` | How many clubs a wallet owns |
| `ClubRulesConfig` | `["club_rules_config"]` | Caps, limits, deposit rules (super admin) |
| `ClubMarket` | `["club_market", market]` | Club, access (`MembersOnly` / `Public`), creator, accrued club fees |
| `ClubFeeConfig` | `["club_fee_config"]` | The club's share of the taker fee, in basis points (at most 50%) |

**Proving membership.**
- **Member:** an initialized `ClubMember` PDA proves membership.
- **Non-member:** an empty PDA proves non-membership, which is what permissionless
  cancellation relies on.

**A separate namespace for club markets.**
- **Seeds:** club markets use their own seeds: `["club_prediction_market", id]`
  and `["club_book", market]`.
- **Why:** public instructions derive the public seeds, so they can't act on a
  club market at all.
- **Shared code:** club instructions run the club checks, then reuse the shared
  custody, matching, complement and resolution code.

## Club markets

- **Creation:** admins create markets, or every member does if the club's policy
  allows it. Each market is members-only or public.
- **Entry actions** (place, split, and both sides of every fill) check current
  membership in members-only markets.
  - **Removed members:** their resting orders can't fill, and anyone may cancel
    them. The funds always return to the owner.
- **Exits** (cancel, withdraw, merge, redeem) never need membership.
- **Resolution:** any current club admin proposes and corrects, under the usual
  windows. Club markets have no fallback resolver. Finalization is
  permissionless.

## Fees

- **Rate:** traders pay the normal taker fee.
- **Split:** `split_club_fee` gives the club its share, rounded down, so the
  protocol keeps any leftover atom and the two parts always add up to the fee
  paid.
- **Withdrawals:**
  - the club owner withdraws the club's share (`withdraw_club_fees`);
  - the super admin withdraws the protocol's share (`withdraw_club_book_fees`).
- **Rate changes:** a change to the share applies only to later fills.
- **Custody:** both parts stay in the global vault until they are withdrawn:

```text
global vault = Σ free + Σ locked + Σ book fees + Σ club fees
```

## Club rules

Every number below is set by the super admin in `ClubRulesConfig` (Admin →
Platform config). Changes apply to new actions.

| Rule | Default |
| --- | --- |
| Club type | `Public` or `Private`, chosen at creation. Only public clubs can be listed. |
| Member cap | 100,000 public / 1,000 private, counting the owner and admins |
| Clubs per owner | 2 |
| Admins per club | 5, including the owner |

- **Caps:** every way of joining checks the cap. Lowering a cap removes nobody.
- **Owner limit:** creating a club and accepting ownership both fail at the
  limit. Closing a club or handing it over frees a slot.

## Security deposit

| | Private | Public |
| --- | --- | --- |
| USDC minimum | $100 | $200 |
| SOL minimum | $120 worth | $240 worth (120% buffer) |

**Paying.**
- **One token:** a club pays in one token. The first deposit fixes which.
  - **USDC:** tUSDC on devnet, held in `["club_deposit_vault", club]`.
  - **SOL:** held in the club account, above its rent.
- **Top-ups:** the owner can top up at any time.

**SOL price.**
- **Feed:** SOL is valued with Pyth's SOL/USD `PriceUpdateV2`, at most 60 s old
  and within 1% confidence.
- **Account:** the app reads Pyth's shared push account
  `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`. If it is stale, the app waits
  for the next update instead of posting a price.

**Market gate.**
- **Rule:** creating or opening a club market needs the deposit at its dollar
  minimum.
- **Below the minimum:** existing markets keep trading and resolving.

**Market counter.**
- **Count:** clubs count their unsettled markets in `live_markets`.
- **Older clubs:** clubs from before M2a stay blocked until the super admin
  records their count once (`set_club_live_markets`).

**Switching type** (`set_club_kind`, owner).
- **Private → public:** needs the deposit at the public minimum. The app adds the
  top-up to the same transaction.
- **Public → private:** needs at most the private cap. It closes the listing and
  refunds the deposit above the private minimum.

**Settling and closing.**
- **Settle** (`settle_club_market`, anyone):
  - **Eligible markets:** a resolved market, or an empty draft past its close
    time, once its club fees have been withdrawn.
  - **Effect:** it writes `["club_market_settled", club_market]` and lowers
    `live_markets`.
- **Close** (`close_club`, owner):
  - **When:** at `live_markets == 0`.
  - **Effect:** it refunds the whole deposit, closes the listing and the owner's
    membership, and frees the owner's slot.
- **Closed clubs stay on chain:**
  - **Account:** the club is marked `closed`, so its ID can never be reused.
  - **Markets:** they stay redeemable.
  - **Members:** they can still leave and get their rent back.
  - **Blocked:** everything else.

## Disputes

These apply to every prediction market: public binary, club and multi-outcome.

**Settings** (`set_dispute_config`, super admin):

| Setting | Value |
| --- | --- |
| Club markets window | 5 days |
| Other markets window | 3 days |
| Bond | 1 whole collateral token |
| Ruling deadline | 7 days |
| Treasury | A wallet |

Markets can't receive proposals until these settings exist.

**The dispute window.**
- **Record:** every proposal creates `["market_dispute", market]`, which fixes the
  window.
- **Finalization:** it waits for both the review delay and the window, and never
  happens while a dispute is open.
- **Corrections:** a correction restarts both, and corrections are blocked while
  a dispute is open.
- **Older markets:** markets proposed before M3 have no record and keep the old
  rule.

**Opening.**
- **Who:** a holder of the market's contracts.
- **When:** inside the window, and only once per market. Every ruling is final.
- **Bond:** it goes to `["dispute_bond", market]`.
- **Effect:** trading has already closed, so a dispute only holds finalization
  and redemption.

**Ruling** (`rule_*_dispute`).
- **Who:** an active protocol admin, before the deadline, who isn't the creator,
  the resolver or the fallback resolver, or (for a club market) one of the club's
  admins.

  | Ruling | Result | Bond |
  | --- | --- | --- |
  | Uphold | Proposed outcome is final | To the treasury |
  | Overturn | The admin's outcome, any valid outcome except Invalid | Refunded |
  | Invalid | Binary pays ½ per side; multi-outcome pays 1/N | Refunded |

- **Club penalty:** Overturn or Invalid on a club market sets `club_penalty_due`.

**Expiry** (`expire_*_dispute`, anyone): once the deadline passes, the market
becomes Invalid and the bond is refunded, with no club penalty.

**App.**
- **Dispute card:** every market page has one, showing the window, the open
  button, the ruling form and the final ruling.
- **Disputes page:** `/disputes` lists open disputes for admins.
- **Finalize buttons:** they wait for the window.

## Next: penalties (M4)

- **Amount:** each Overturn or Invalid club ruling takes **$50** from the club's
  deposit, or whatever is left.
  - **SOL deposits:** valued at the Pyth price.
- **Split:** 50% to the wallet that won the dispute, 50% to the treasury.
- **Effect:** a club below its minimum loses market creation until it tops up.
- **UI:** penalty history, plus "top up to keep creating markets".

After M4 come indexing of deposits, disputes and penalties (M5) and Canton
parity (M6). Creator Clubs stages CC2–CC6 are in the [roadmap](roadmap.md).

## Risks

- **Pyth dependency:** SOL deposits depend on Pyth.
- **Sybil wallets:** extra wallets get around the owned-club limit, but the
  deposit makes that costly.
- **Spam disputes:** the bond is small, but one dispute per market bounds spam.
- **Admin rulings:** admins rule on disputes. That is a trusted process, not
  decentralized resolution.
