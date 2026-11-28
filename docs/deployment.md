# Devnet deployment

Every account here is on Solana devnet and has no value. Record only public
addresses and signatures here: never keys, seed phrases or keypair contents.

## Program and governance

| Account | Address |
| --- | --- |
| Program | [`AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet) |
| ProgramData | `A4zPViwdWBgB7ttkEg5dGqumXJ7ZygogEwVHgUb3VBrY` |
| Upgrade authority, super admin | `BX6RJHGbi7msj7t1ECCX6T1ZvvetHDK6UkjzAhPfWngq` |
| Protocol config `["protocol_config"]` | `433qRcpUj1dizPRRp5Cghr6h3sfje8S6HXq4kkAxScmG` |
| Super-admin record `["admin", authority]` | `9S5PMZmbnm3YvAsi3quKGChE16qJaMS1uAbUnkJ5a5xg` |

## Settings

| Setting | Value |
| --- | --- |
| Taker fee | 10 bps |
| Club rules | 100,000 / 1,000 members, 2 clubs per owner, 5 admins |
| Deposit rules | tUSDC `FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd`, $100 / $200, 120% SOL buffer, Pyth SOL/USD, 60 s, 1% |
| Disputes | 5 days club / 3 days other, bond 1 token, 7-day ruling deadline, treasury `BX6R…Wngq` |

## Test tokens

All tokens use the legacy SPL Token program
(`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).

| Token | Mint | Decimals |
| --- | --- | --- |
| tUSDC (prediction collateral) | `FUU2RPtv519UtUD2apwBRUM8BT2x2Kew71AxRRLMCAbd` | 6 |
| tBTC (faucet base) | `FggaZG7eJ5tpr2vmpNMbMCHkWkcw9n2Nhmf54g3wQwGk` | 8 |
| tUSDT (faucet quote) | `8KRa3QwidV2yZspR3wr4p3eNzq2KtejMbU1tZUgNLdtt` | 6 |

**Server faucet.**
- **Authority:** the `tBTC/tUSDT` mint authority is a dedicated server key,
  `8S2nAYrpqBoPFvXj7HSGHvuGnpNBEk1RHUbXQXmMB84B`. Its secret lives only in the
  encrypted Vercel settings (`FAUCET_AUTHORITY_SECRET_KEY`).
- **What a claim does:** it mints fixed amounts and creates missing token
  accounts.
- **Limits:** one claim per wallet, and five per hashed IP per hour, counted in
  Upstash Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
  - **Without Redis:** the faucet turns itself off.
  - **Sybil resistance:** none.
- **Mainnet:** never use this design for valuable assets.

## Upgrading

```bash
anchor build
anchor test --skip-deploy
solana program show AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL -u devnet
# extend first if the new .so is larger than the program account
solana program extend AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL <bytes> -u devnet
solana-keygen new --no-bip39-passphrase -o <private-dir>/buffer-keypair.json
solana program deploy target/deploy/outcomia.so \
  --program-id AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL \
  --upgrade-authority ~/.config/solana/id.json \
  --buffer <private-dir>/buffer-keypair.json --use-rpc
```

**Rules.**
- **Program ID:** always pass `--program-id`. In a fresh checkout, `anchor build`
  makes a random `target/deploy/outcomia-keypair.json`, and a bare
  `anchor deploy` would deploy to a new address. Don't run `anchor keys sync`.
- **RPC:** prefer an authenticated RPC (`-u`), because public devnet rate-limits
  writes.
- **Resuming:** rerun the same command with the same buffer key.
- **Verification:**
  - **Bytes:** dump the program and compare the first `len(outcomia.so)` bytes
    with the local build.
  - **Accounts:** compare the program-account hashes from before and after.
- **IDL:** upgrades skip the on-chain IDL (`--no-idl`), because Anchor's metadata
  step fails with `Cannot find module '@solana/kit'`. The app uses the locally
  built IDL (`app/scripts/sync-idl.mjs`).
- **Order:**
  1. **Indexer first:** rebuild it from `master`. It keeps older IDLs, so it
     decodes both versions.
  2. **Program:** upgrade it.
  3. **Settings:** set any new ones in Admin → Platform config.
  4. **App:** Vercel deploys the app from `master`.

## Release history

| Date | Release | Size | Notes |
| --- | --- | --- | --- |
| 2026-11-28 | Club deposits, lifecycle, disputes (M2a, M2b, M3) | 2,743,192 B (extended by 340,000) | Slot 527209470; byte-identical; settings above applied; counts recorded for the 6 existing clubs |
| 2026-11-23 to 25 | Public clubs (CC1), then club rules (M1) | 2,403,192 B after M1 | Club rules set; existing clubs upgraded |
| 2026-11-22 | Clubs and private markets | 2,229,320 B | Slot 525062763; all 70 accounts unchanged |
| 2026-11-21 | Complementary matching | 1,816,760 B | `match_shared_complement`, `match_multi_outcome_complement` |
| 2026-11-21 | Release hardening and multi-outcome | 1,727,496 B | Two-wallet multi-outcome smoke test passed |
| 2026-11-06 | Shared wallet, resolution, redemption | 1,399,440 B | All 17 accounts unchanged |

Evidence from smoke runs is in [`devnet/`](devnet/) (`*-result.json`).

**Older deployments.** These are history only; the current IDL doesn't support them.
- **Program `BPdNF5Cn…PgWL`:** the previous full-feature deployment.
- **Program `Honq7kkN…393cR`:** an even earlier market layout.
- **Market `9t1vydxL…9kqa`** (`tBTC/tUSDT`): uses the layout from before
  `open_order_count`.
