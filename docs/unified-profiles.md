# One profile for Solana and Canton, with combined PnL

Status: agreed (2026-11-27). Milestone 1 built (see Progress).

**Decisions (2026-11-27):**
- **Either chain:** a trader can sign in and create a profile with a Solana wallet
  *or* a Canton party, and link the other later.
- **Canton proof:** a ledger claim, not `signMessage`.
- **Combined PnL:** every asset is converted to USD with a price source, not only
  USD-pegged collateral.

## Goal

- A trader has **one public profile** (username, name, bio, links) that shows on both
  the Solana and the Canton side of the app.
- The profile page shows **PnL per chain** and a **combined PnL** once both chains have
  trade history.

## Today

- Profiles live in the Solana indexer (`profiles` table, keyed by Solana wallet).
  Only a signed-in Solana wallet (signed challenge, `outcomia_session` cookie) can
  write its own profile.
- PnL comes from the Solana indexer's `traderStats`, per collateral mint: realized,
  unrealized, volume, trades.
- Canton has no profiles. Canton trade history needs the Canton indexer, which runs
  only on LocalNet today (CantonGrid 0.4.0 has no remote/TestNet sources).

## Linking a Canton party to a profile

A profile gets a list of **linked accounts**. A link is created only when the trader
proves control of **both** sides in the same flow.

**Why not `signMessage`?** CIP-0103 defines `signMessage` (message in, signature out),
but not the signature format, the key, or how to check it against a party ID. Wallets
also disagree on the message encoding. A server cannot safely verify it today.

**Proof on the ledger instead.** Every Canton wallet can already sign transactions
through `prepareExecute` (our CIP-0103 path):

1. The trader signs in with their Solana wallet (existing session) and asks to link
   Canton.
2. The indexer issues a short-lived nonce bound to that session (same rate limits as
   sign-in challenges).
3. The Canton wallet creates a `ProfileClaim` contract (purpose `Link`) (new Daml template):
   - signatory: the trader's party;
   - observer: the operator;
   - fields: `purpose`, `solanaWallet`, `nonce`.
   This costs one ordinary ledger transaction and needs no funds.
4. The indexer reads the claim from the ledger with a read-only operator token and
   checks party, wallet, nonce and age (at most 10 minutes).
5. The indexer stores the Canton party as an account of the signed-in user.
   A party links to at most one profile; re-linking requires unlinking first.
6. The trader (or the operator) archives the claim afterwards. Unlinking is a signed-in
   Solana action and needs no ledger transaction.

**Canton sign-in** uses the same claim with purpose `SignIn` (no Solana session
needed): the indexer issues a nonce for the party, the wallet creates the claim, and
the indexer checks it and starts a session for that party's user.

## Data model (Solana indexer)

- `users(id)` becomes the profile identity. `users.wallet_address` becomes nullable
  (a Canton-only user has none).
- New `user_accounts(user_id, chain, network, address, linked_at)`:
  - `chain` is `solana` or `canton`; `UNIQUE(chain, network, address)`, so an
    account belongs to one user;
  - existing users are back-filled with their Solana wallet.
- `profiles` is re-keyed from `wallet` to `user_id`. The GraphQL `Profile.wallet` stays
  (the linked Solana wallet, now optional) and gains `accounts`.
- `canton_challenges(nonce_hash, party, purpose, user_id?, expires_at, consumed_at)`,
  with the same rate limits as Solana sign-in.
- **Merging:** if the Canton party being linked already has its own user, linking is
  refused until that user unlinks or deletes its profile. Two profiles are never
  merged silently.

**Who reads the claim:** the indexer itself, with optional
`CANTON_JSON_API_URL` / `CANTON_READ_TOKEN` config (a read-only operator token). Auth
logic stays in one place. Without that config, Canton sign-in and linking are off.

## The `ProfileClaim` template (outcomia-canton)

- Fields: `operator`, `party`, `purpose` (`SignIn | Link`), `nonce` (hex, 32–64
  characters), `solanaWallet : Optional Text` (for `Link` from a Solana session).
  There is no time field: the indexer uses the ledger's own creation time.
- Signatory `party`, observer `operator`. The operator may clear it (`ProfileClaim_Clear`).
- Built: outcomia-canton `Outcomia.Profiles` (branch `feat/profile-claims`, 3 tests).
- The nonce makes it single-use; the indexer also rejects claims older than 10 minutes.

## Showing the profile on both sides

- `/u/<username>` resolves a username, a Solana wallet or a linked Canton party.
- Canton market pages, leaderboards and the Canton positions page show the linked
  profile's name and avatar for a party, exactly as the Solana side does.
- The profile page lists linked accounts (Solana wallet, Canton party) with explorer
  links where they exist.

## Combined PnL

- **Per chain:** Solana PnL from the Solana indexer (as today). Canton PnL from the
  Canton indexer's trade-fill, reserve and resolution models, computed the same way:
  realized from fills, redemptions and fees; unrealized at the last trade price.
- **Combined:** each asset is converted to USD and added up. A small price config
  maps every collateral asset to a source:
  - fixed `1.0` for USD stablecoins (USDC, outcomia-tUSDC, Canton USD tokens);
  - a Pyth feed for SOL (and for CC when a feed is configured), read from Hermes.
  PnL is valued at the current price, so the total moves with prices. An asset with
  no price source is shown on its own and left out of the total, with a note.
- **Where it is computed:** the app server queries both indexers and merges them. The
  Solana indexer does not read Canton data.
- **Until Canton is live:** the profile shows Solana PnL and a "Canton: not yet
  available" row. The combined total appears only when the Canton indexer returns
  data for a linked party.

## Milestones

1. **Accounts and Canton sign-in:** `ProfileClaim` template and tests; indexer
   `user_accounts` migration, Canton challenge/verify, link/unlink; app sign-in with
   a Canton wallet, link flow and linked-accounts list.
2. **Canton display:** resolve parties to profiles on Canton pages and `/u/<party>`.
3. **Canton PnL:** a Canton stats query over the Canton indexer, shown per chain.
4. **Combined PnL:** price config and the merged USD total on the profile page.

Milestones 1–2 work today. Milestones 3–4 need the Canton indexer to be deployed.

## Progress

**Milestone 1 — built (2026-11-27):**
- outcomia-canton `Outcomia.Profiles`: `ProfileClaim` and 3 Daml tests.
- Indexer: migration `20261127090000_canton_accounts` (`canton_accounts`,
  `canton_challenges`, profiles owned by `user_id`); `/auth/canton/challenge`,
  `/auth/canton/verify`, `/auth/canton/unlink`, `/auth/solana/link`; claims read by
  `canton::LedgerClaims`; `profile(party:)` and `Profile.cantonParties`. Tests cover
  bad claims, sign-in, link, merge and unlink against PostgreSQL with a fake ledger.
- App: `lib/canton/profile-claim.ts` (challenge → `prepareExecute` create → find the
  claim → verify); the session provider keeps Canton sessions and links Solana
  wallets; `/u/<party>` and Canton-only profiles; sign-in with Solana or Canton on
  `/u/<id>/edit`; a linked-accounts card.

**Not verified yet:** a real Canton wallet creating a claim end to end. It needs a
deployed DAR that contains `Outcomia.Profiles` (the package id changes, so the
app's `CANTON_PACKAGE_ID` and the indexer's `CANTON_PROFILES_PACKAGE_ID` must
both point at the new DAR) and the indexer's `CANTON_*` settings.

**Next:** milestone 2 (names and avatars for parties on Canton pages), then 3–4
once the Canton indexer is deployed.
