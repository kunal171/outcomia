# Profiles and P&L

A trader has one public profile (username, name, bio, links) shared by the
Solana and Canton sides of the app. The profile shows P&L per chain and, once
both chains have history, a combined USD total.

| Milestone | Status |
| --- | --- |
| 1. Accounts, Canton sign-in and linking | Built (outcomia-canton #36, outcomia #106) |
| 2. Canton parties shown as profiles | Built |
| 3. Canton P&L | Blocked (see below) |
| 4. Combined USD P&L | Built for Solana (#107) |

## Accounts

- **Storage:** profiles live in the Solana indexer and are owned by a `user_id`.
- **Linked accounts:** a user has linked Solana wallets and Canton parties. Each
  account belongs to one user.
- **Sign-in:** a trader can sign in with either chain and link the other later.
- **No merging:** if a party already has its own user, linking is refused, so two
  profiles are never merged silently.

**Solana sign-in:** a signed challenge sets the `outcomia_session` cookie.

**Canton sign-in and linking use a ledger claim instead of `signMessage`.**
- **Why not `signMessage`:** CIP-0103 doesn't fix the signature format or how to
  check it against a party, so a server can't verify it safely.
- **Steps:**
  1. The indexer issues a short-lived nonce (`/auth/canton/challenge`).
  2. The wallet creates a `ProfileClaim` (outcomia-canton `Outcomia.Profiles`)
     through `prepareExecute`.
     - **Parties:** the signatory is the party and the observer is the operator.
     - **Fields:** `purpose` (`SignIn` or `Link`), `nonce` and an optional
       `solanaWallet`.
  3. The indexer reads the claim with a read-only operator token and checks the
     party, wallet, nonce and age (at most 10 minutes) (`/auth/canton/verify`).
  4. It starts a session, or links the party to the signed-in user.
- **Unlinking:** a signed-in Solana action (`/auth/canton/unlink`), with no
  ledger transaction.
- **Indexer settings:** `CANTON_JSON_API_URL`, `CANTON_READ_TOKEN` and
  `CANTON_PROFILES_PACKAGE_ID`. Without them, Canton sign-in is off.

## Display

- **`/u/<id>`:** resolves a username, a Solana wallet or a linked party.
- **Party names:** Canton pages, club rosters and the header show a party's profile
  name and avatar (`partyProfiles(parties:)`, cached in `lib/party-profiles.ts`).

## P&L

- **Solana:** comes from the indexer's `traderStats`, per collateral mint.
  - **Realized:** from fills, redemptions and fees.
  - **Unrealized:** at the last trade price.
- **USD conversion:** `lib/prices` maps each asset to a price, served by
  `/api/prices`.
  - **Stablecoins:** USD stablecoins are fixed at 1.0.
  - **SOL and BTC:** use Pyth Hermes, which needs `PYTH_API_KEY`. Without it,
    those assets show as unpriced and are left out of the total.
- **Combining:** `combinePnl` adds the per-asset rows in exact USD.

**Why Canton P&L (milestone 3) is blocked.** The Canton indexer has fills and lots
but not:
1. **Missing receipts:** receipts for cash that skips a fill (redemptions,
   splits, merges) need new Daml templates.
2. **Complement fills:** indexed complement fills.
3. **Full-set legs:** per-party full-set legs. `MultiFullSetFill` stores owners in
   lists, which the engine can't project.
4. **Model cap:** CantonGrid allows 16 models, and all 16 are used.
5. **Deployment:** remote/TestNet sources in CantonGrid and an operator read token.

Order of work: Daml receipts, then CantonGrid's model cap, the indexer models, an
app route producing `PnlRow`s, and finally deployment.

**Not verified:** a real Canton wallet creating a claim end to end. It needs a
deployed DAR with `Outcomia.Profiles`, with the app's `CANTON_PACKAGE_ID` and the
indexer's settings pointing at it.
