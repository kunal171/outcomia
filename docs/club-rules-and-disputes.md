# Club rules, security deposits and outcome disputes

Status: agreed plan (2026-11-25). Solana implementation in progress; Canton is tracked below and not started.

Every contract change ships with its matching UI in the same milestone.
Canton clubs get the same rules after Solana. The super admin can change every
number below through one `ClubConfig` account.

## 1. Club types and limits

| Rule | Default | Notes |
| --- | --- | --- |
| Club type | chosen at creation | `Public` or `Private`. It is stored on the club and no longer inferred from the listing. Only public clubs can be listed. |
| Member cap, public | 100,000 | The owner and admins count as members. |
| Member cap, private | 1,000 | |
| Clubs a wallet may own | 2 | Any mix of public and private. Being an admin of another club does not count. |
| Admins per club | 5 | Includes the owner. |

**Member caps**
- Joining, accepting an invite and approving a request all fail when the club is at its cap.
- If the super admin lowers a cap below a club's current size, no one is removed. New joins are blocked until the club is under the cap again.

**Club ownership limit**
- A per-wallet record (`["club_owner", wallet]`) counts the clubs the wallet owns.
- Creating a club or accepting a club's ownership fails at the limit.
- Closing a club, or handing ownership to someone else, frees a slot.

**Switching type**
- Private → public: requires the higher member cap and a deposit top-up to the public minimum.
- Public → private: allowed only when the club has at most 1,000 members. The listing is removed and the excess deposit is refunded.

## 2. Security deposit

| | Private | Public |
| --- | --- | --- |
| Minimum paid in USDC | $100 | $200 |
| Minimum paid in SOL | $120 worth | $240 worth |

**Which token**
- USDC on mainnet, outcomia-tUSDC on devnet. The super admin sets the mint.
- SOL is valued with the Pyth SOL/USD feed when the deposit is paid. The price must be at most 60 seconds old and its confidence band within limits, or the transaction fails.
- SOL needs 120% of the dollar amount, as a buffer for price drops.
- A club holds its deposit in one token, chosen at creation.

**Holding and refunds**
- The deposit sits in a program vault for each club.
- It is refunded to whoever owns the club when the club closes.
- The owner can top it up at any time.

**Below the minimum**
- A club is below the minimum when:
  - USDC: the remaining balance is under the minimum;
  - SOL: the remaining balance, valued at the current Pyth price, is under the dollar minimum.
- While below the minimum, the club **cannot create or open new markets**. Its existing markets keep trading and resolving.
- A top-up restores the club.

**Existing clubs**
- Existing clubs (6 on devnet) are migrated: their type comes from their current listing.
- They start with no deposit, so they are below the minimum until they pay one.

## 3. Dispute window before payout

This applies to every prediction market, binary and multi-outcome.

| Market | Dispute window after the final proposal |
| --- | --- |
| Club markets | 5 days |
| Regular markets | 3 days |

**Redemption**
- Nobody can redeem until the window ends with no dispute open, or a ruling has been made.
- Corrections by the resolver restart the window, as they restart the delay today.

**Opening a dispute**
- Any wallet holding contracts in the market can open one, while the window is open.
- It costs a bond of $1 in the market's collateral token.
- Only one dispute can be open per market at a time. There is a configurable limit on disputes per market (default 3).

**What a dispute does**
- It **pauses** the market: no orders, fills, splits or redemptions. Cancelling orders stays allowed.

**Who rules**
- Any protocol admin, **except**:
  - the market's creator;
  - the market's resolver;
  - for club markets, any admin of that club.

**Possible rulings**

| Ruling | Effect |
| --- | --- |
| Uphold | The proposed outcome is final. The disputer's bond goes to the treasury. |
| Overturn | The admin's outcome is final. The bond is refunded. For a club market the club is **penalized** (section 4). |
| Invalid | Binary pays ½ per contract to each side; multi-outcome pays 1/N to each outcome. The bond is refunded. For a club market the club is penalized. |

**No ruling within 7 days of the dispute**
- The market becomes **invalid**.
- The bond is refunded.
- The club is not penalized, because nobody found it wrong.

## 4. Penalty for a wrong outcome (club markets)

**Amount and split**
- Each Overturn or Invalid ruling takes **$50** from the club's deposit.
- SOL deposits are converted at the current Pyth price.
- If the deposit holds less than $50, the program takes what is left.

| Recipient | Share |
| --- | --- |
| Wallet that won the dispute | 50% |
| Outcomia treasury | 50% |

**Effect on the club**
- If the remaining deposit falls below the minimum, the club loses market creation until it tops up (section 2).

## 5. Closing a club

The owner can close the club only when:
- every club market is resolved, past its dispute window, and has no open dispute;
- the club's accrued fees have been withdrawn.

Closing the club:
- refunds the remaining deposit to the owner;
- removes the listing;
- frees the owner's slot.

Members can still close their membership accounts afterwards to get their rent back.

## 6. Configuration (super admin)

`ClubConfig` holds:
- **Limits:** member caps; owned-club limit; admin limit; disputes per market.
- **Deposits:** minimums in USD (6 decimals); SOL buffer (bps); deposit mint; Pyth feed id; maximum price age and confidence.
- **Disputes:** penalty; split between disputer and treasury; club and regular dispute windows; dispute bond; ruling deadline.
- **Treasury:** the treasury wallet.

Changes take effect for new actions. Windows already running keep the length they started with.

## 7. Milestones

Each milestone ships its program change together with its UI. The indexer and Canton follow.

1. **Config and limits:** `ClubConfig`; club type; member caps; owned-club limit; admin limit.
   - UI: club type at creation, caps shown on the club page, a super-admin settings page.
2. **Deposits:** USDC and SOL (Pyth) deposits; top-up; switching type; closing a club; migrating existing clubs.
   - UI: deposit step at creation, deposit status and top-up, close-club flow.
3. **Disputes:** dispute window on all prediction markets; disputes with bond; pause; rulings with eligibility checks; 7-day timeout to invalid.
   - UI: dispute button and countdowns on markets, an admin dispute queue.
4. **Penalties:** $50 deduction and split; below-minimum gating.
   - UI: penalty history and "top up to keep creating markets".
5. **Indexer:** index deposits, disputes, rulings and penalties, and expose them in GraphQL. Leaderboards ignore disputed markets until they are ruled.
6. **Canton parity:** the same rules for Canton clubs and markets, following CIP-0103 for wallet flows.

Each program milestone needs a devnet program upgrade and a check that existing markets are not affected.

## 8. Risks and notes

**SOL price**
- SOL deposits depend on Pyth.
- The client must post a fresh Pyth price update in the same transaction. This is the pull-oracle model: the app fetches the update from Hermes.

**Sybil wallets**
- The owned-club limit can be bypassed with extra wallets.
- The deposit is what makes that costly.

**Spam disputes**
- The $1 bond is small. The per-market dispute limit and the pause-only-while-open rule keep spam disputes bounded.

## 9. Canton status (to do, not started)

Canton clubs get every rule above after Solana ships it. Canton wallet flows
follow CIP-0103. Each row moves to "done" only with its Canton UI.

| Rule | Solana | Canton |
| --- | --- | --- |
| Club type (public / private) chosen at creation | M1 (built) | To do |
| Member caps 100,000 / 1,000 (configurable) | M1 (built) | To do |
| Max 2 owned clubs per wallet | M1 (built) | To do |
| Max 5 admins per club | M1 (built) | To do |
| Platform config (super admin) | M1 (built) | To do |
| Security deposit $100 / $200, USDC or SOL-equivalent | M2 | To do (Canton deposit asset to be decided) |
| Close club and refund the deposit | M2 | To do |
| Dispute window: 5 days club markets / 3 days regular markets | M3 | To do |
| Disputes: $1 bond, pause, ruling by an eligible admin, 7-day timeout → invalid | M3 | To do |
| $50 penalty, split 50/50 between disputer and treasury; below-minimum gating | M4 | To do |

## 10. Milestone 1 deployment order (devnet)

The new indexer decodes both the old and the new program (it keeps the
previous IDL as history), but the old indexer cannot decode the new
instructions. The app's club forms need the new program. So:

1. **Indexer first.** Merge, then rebuild the Northflank indexer from
   `master`. It moves its database to the new IDL automatically and keeps
   working against the current program.
2. **Program upgrade.** `anchor build`, then upgrade program
   `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL` on devnet with the upgrade
   authority.
3. **Club rules.** As super admin: Admin → Platform config → Set club rules
   (100,000 / 1,000 / 2 / 5). Until then nobody can create or join clubs.
4. **Upgrade existing clubs.** In the same tab, upgrade each club listed under
   "Clubs awaiting upgrade" (listed clubs as public). Until a club is upgraded
   it cannot accept members.
5. **App.** Vercel deploys from `master`. If the app deploys before step 2,
   creating or joining a club fails until the program is upgraded.
