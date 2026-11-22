# Devnet Deployment

## Current deployment

| Property                      | Value                                          |
| ----------------------------- | ---------------------------------------------- |
| Cluster                       | Solana devnet                                  |
| Program ID                    | `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL` |
| ProgramData address           | `A4zPViwdWBgB7ttkEg5dGqumXJ7ZygogEwVHgUb3VBrY` |
| Upgrade authority             | `BX6RJHGbi7msj7t1ECCX6T1ZvvetHDK6UkjzAhPfWngq` |
| Last verified deployment slot | `525062763`                                    |

[Open the program in Solana Explorer](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet).

## Clubs and private markets: 22 November 2026

Upgrades devnet to the clubs build (milestones 1–5: clubs, membership, club
fee share, binary club markets and club trading).

- SHA-256: `7c4e706e98e1907dab2f92eba8aa0d56c74f335e770e85b72ba388347c0b1960`
  (deployed bytes dumped and compared with the local build).
- Length: 2,229,320 bytes; ProgramData was extended by 412,560 bytes (about
  2.1 SOL, permanent). The buffer was closed and its rent refunded.
- Upgrade transaction:
  `NM9SfvSqAfWSP1z3CgfVmZmrWLU9Duhz5p3XjJpqpcbfEnStKMyedVr51oXbDSQtUFmuhAR7Leb5rPhvpv3iCjC`
  (slot 525062763).
- All 70 existing program accounts were hashed before and after the upgrade;
  none changed, appeared or disappeared.
- No governance setting changed: the taker fee stays at 10 bps and no club fee
  share is configured (club fills credit the club nothing until the
  super-admin sets one with `set_club_fee_share`).
- [Club smoke result](devnet/club-smoke-result.json), produced by
  `RPC=<url> WALLETS=<private path> RESULT=docs/devnet/club-smoke-result.json
  node app/scripts/local-club-e2e.mjs <authority>`.

The smoke used a fresh valueless mint and four temporary wallets funded by
transfer, and created a club named "Smoke test - club" with a members-only
market "Smoke test - club market". Club markets never appear in public
discovery; the smoke club is visible only to its members.

Devnet dropped and delayed transactions during the run. An early version of
the script resent a removal whose first attempt had landed, which the program
rejected (`AccountNotInitialized`): no state was double-applied. The script now
signs once and rebroadcasts the same bytes, re-signing only after the
signature provably expired without landing, and saves temporary keypairs
before funding so interrupted runs can be swept. The first interrupted run
predated that and stranded about 0.24 devnet SOL in unsaved wallets.

Keep `NEXT_PUBLIC_CLUBS_ENABLED=false` on Vercel until the app with the club
pages is deployed and checked.

## Complementary matching: 21 November 2026

Upgrades devnet to `master` at `ce636ba`: binary complementary matching
(`match_shared_complement`), multi-outcome full sets
(`match_multi_outcome_complement`) and the related placement guards.

- SHA-256: `a32857d5d546359f645cfecb8731cd25bce319e108d7524d02c1864d00b790e8`
  (dumped and compared with the local build); 1,816,760 bytes. ProgramData
  auto-extended by 89,264 bytes (about 0.45 SOL, permanent).
- Upgrade transaction:
  `2eQUpAvXacQqPXQsmopsRMYvQDoAcz5jsRA6AXyb4ToAXHLrjEyRmnQaPRchkTkayT3UNt6ixTAV2KT82vMjEKxe`.
- All 49 existing program accounts were hashed before and after; none changed,
  appeared or disappeared.
- [Smoke result](devnet/complement-smoke-result.json) from
  `app/scripts/devnet-complement-smoke.mjs`, first dry-run on a local
  validator with the same build.

The smoke used a fresh valueless mint and a temporary trader on hidden
"Smoke test - ..." markets: a binary complement mint and merge, a three-outcome
full-set mint in which one maker held both other legs, and a frozen market
lookup table created on devnet followed by a full-set merge sent as a 454-byte
v0 transaction. Supplies, backing and real reserve tokens were checked after
every fill; the trader's cash and SOL were returned. Both markets are hidden by
name and address.

The first upload stalled on public-RPC rate limits after ProgramData was
extended; the live program stayed the previous release followed by zeros
(verified by hash). Resuming the same buffer through the Helius RPC completed
the upgrade. `NEXT_PUBLIC_COMPLEMENTARY_MATCHING_ENABLED=true` was then set for
Vercel Production and Preview, production was redeployed from the same `master`
build, and the live bundle was confirmed to compile the flag on.

## Release hardening and multi-outcome: 21 November 2026

Upgrades devnet to the release-hardening build, which also carries the
previously undeployed multi-outcome program.

- SHA-256: `4525a47616016fd4dcf9b83ceeede2afb741c401c828fd1d1e95ea22a5b96b95`
  (deployed bytes dumped and compared with the local build).
- Length: 1,727,496 bytes; ProgramData was auto-extended by 328,056 bytes
  (about 1.67 SOL, permanent).
- Upgrade transaction:
  `8LdYn5QVUuGdowEJ5JEDrxc6VWkeC8MfB7E4mPVo5bucoKT1QvAMTDwqnsZhWQTKCqa4huV7CZZFax3u2w334vo`.
- All 40 existing program accounts were hashed before and after the upgrade;
  none changed, appeared or disappeared.
- [Smoke result](devnet/release-smoke-result.json) and its
  [rules document](devnet/release-smoke-rules.json).

The smoke used a fresh valueless mint and a temporary second wallet. It
simulated a too-fine spot market (rejected with `SpotIncrementsTooFine`; no
spot market was created) and ran a full multi-outcome lifecycle on a hidden
market named "Smoke test - multi-outcome lifecycle": split, resting sell,
matched buy through the app's trade builder, cancellation, freeze, proposal,
two corrections, a correction rejected with `PredictionCorrectionWindowClosed`
at the phase deadline while the proposal was still immature, permissionless
finalization by the second wallet, redemption by both wallets, fee and cash
withdrawal. Reserve and shared-vault backing were checked after every step.
The token supply was burned to zero and the temporary wallet's SOL returned.
The market is hidden by name and address and remains reachable for audit.

The first upload attempt sent writes through validator TPU ports; 20 failed.
The CLI had already extended ProgramData, so the program briefly ran the old
6 November bytes followed by zeros (verified by hash; behavior unchanged).
Resuming the same buffer with `--use-rpc` completed the upgrade and refunded
the buffer. No second buffer was allocated.

After the smoke test, `NEXT_PUBLIC_MULTI_OUTCOME_ENABLED=true` was set for
Vercel Production and Preview and production was redeployed from the same
`master` build. The compiled flag was confirmed enabled in the live bundle.
Production has no `INDEXER_API_URL`, so the indexer proxy reports itself
unconfigured and multi-outcome screens read accounts over RPC.

## Shared-wallet release: 6 November 2026

At the 6 November verification, the deployed executable matched that release build.
These are historical release measurements, not the hash of a later local rebuild:

- SHA-256: `484c86e0a4901bb59dfcb8577a30ce9188e2c7a9144cd5ec7b3d6a3170c6ede7`
- Length: 1,399,440 bytes.
- [Upgrade transaction](https://explorer.solana.com/tx/2WWikPwvAubAoSwcWPLwQeW6AVGoxSa649Snk8c3TgWwmWNMYdZpANm2DYp29zpmaxJJkhDjGPY9LQMYk6cjBjQZ?cluster=devnet).
- All 17 existing program account data hashes were preserved.
- [Live smoke evidence](devnet/shared-smoke-evidence.json),
  [completed test](devnet/shared-smoke-result.json), and
  [existing-market activation](devnet/shared-live-markets.json).

The two-wallet test used fresh mints. It checked shared spot and YES trades,
reuse of the same quote balance, paused cancellation, reserve conservation,
creator proposal, delayed finalization by the second wallet, redemption, fee
withdrawal, asset withdrawal and safe spot shutdown. Both test-token supplies
were burned and spare test-wallet SOL returned. One earlier unfunded test Draft
expired; it remains listed in the completion report with no claims or reserve.

The original spot market now has a separate shared book. No old cash, locks or
orders were moved. Owners can cancel legacy orders and move free cash through
`/wallet`. Production/Preview rollout flags enable shared balances and resolution.

Helius browser requests now use `/api/solana`. The Helius URL and API key are
server-only Vercel Secrets. Public Config holds the proxy flag and key-free
fallback/WS URLs. The route bounds methods, scans, batches and payload sizes;
errors cannot return the upstream credential. Redis remains required for public
faucet claims; this release does not enable the deferred faucet counter fallback.

During this upgrade, Helius returned null for the funded loader buffer while
the official RPC returned its confirmed/finalized account. Both reported the
devnet genesis. Resuming the same buffer through the official RPC succeeded;
no extra buffer was allocated. Keep a failed deployment's checkpoint and check
the buffer's authority/state before trying to create another one.

## Deploying updates

Build and verify before every upgrade:

```bash
anchor build
anchor test --skip-deploy
# Upgrade the existing program explicitly; keep the buffer key to resume.
solana-keygen new --no-bip39-passphrase -o <private-dir>/buffer-keypair.json
solana program deploy target/deploy/outcomia.so \
  --program-id AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL \
  --upgrade-authority ~/.config/solana/id.json \
  --buffer <private-dir>/buffer-keypair.json --use-rpc
```

Afterwards, dump the program and compare the first `len(outcomia.so)` bytes
with the local build's SHA-256, and compare program-account hashes taken
before and after the upgrade. A failed upload can be resumed by rerunning the
same command with the same buffer key. Prefer an authenticated RPC (pass it
with `-u`); the public devnet endpoint rate-limits the write transactions.

**Do not rely on `target/deploy/outcomia-keypair.json` in a fresh checkout.**
`anchor build` generates a new random keypair when the file is missing, and
`anchor program deploy` would then target that new address instead of
upgrading the live program. Always pass `--program-id` explicitly, or restore
the original keypair from secure storage first.

Bare `anchor test` deploys to the provider cluster before executing the test
script. Use `--skip-deploy` for the LiteSVM-only local verification workflow.

The original deployment keypair determines the program address. It is intentionally excluded from Git and must be preserved
securely; replacing it would create a different program ID.

## Public test-faucet bootstrap

The web faucet uses a dedicated server-side devnet keypair as the mint authority
for one configured pair. The route mints fixed amounts directly to the
requester's associated token accounts and pays their creation rent when needed.
Never use this design for valuable or mainnet assets.

Required server-only variables are listed in `app/.env.example`. Store
`FAUCET_AUTHORITY_SECRET_KEY` only in encrypted Vercel environment settings.
Vercel also requires `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`; without them the endpoint reports itself disabled
and rejects claims. `FAUCET_ALLOW_IN_MEMORY_RATE_LIMIT=true` is permitted only
for local testing.

Bootstrap order:

1. Generate a dedicated keypair and fund it with a small amount of devnet SOL.
2. Configure the fixed mint addresses, atomic claim amounts, and claim window.
3. Transfer both devnet mint authorities to the dedicated public key.
4. Configure durable Upstash credentials in Vercel.
5. Deploy the web application and open a market using that exact ordered mint
   pair.
6. Connect a wallet and use **Claim test tokens**. The server creates missing
   associated token accounts and atomically mints both configured assets.
7. Confirm that a repeated request is rejected with HTTP `429`.

The current shared pair, public authority, and authority-transfer transactions
are recorded in `docs/devnet-addresses.md`. The secret authority bytes must
never be copied into that registry.

The on-chain `TestFaucet` PDA remains available as a separate research path.
It must not be initialized for mints already controlled by the server faucet.

## IDL metadata limitation

The first `anchor deploy` invocation successfully deployed the executable but
failed during the separate IDL metadata step. Anchor invokes the latest
`@solana-program/program-metadata` CLI through `npx`. Version `0.9.4` requires
`@solana/kit` as a peer dependency, but it was absent from the temporary npx
environment, producing `Cannot find module '@solana/kit'`.

The program deployment itself is valid and independently verified with
`solana program show`. Until the upstream packaging path is fixed, upgrades use
`--no-idl`, and the frontend uses the IDL generated locally by `anchor build`.

No matching open issue was found in the program-metadata repository at the time
of the initial deployment. This is a candidate for a focused upstream report or
contribution after a minimal standalone reproduction is prepared.
