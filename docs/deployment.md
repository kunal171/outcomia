# Devnet Deployment

## Current program

| Property | Value |
| --- | --- |
| Cluster | Solana devnet |
| Program ID | `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL` |
| ProgramData | `A4zPViwdWBgB7ttkEg5dGqumXJ7ZygogEwVHgUb3VBrY` |
| Upgrade authority | `BX6RJHGbi7msj7t1ECCX6T1ZvvetHDK6UkjzAhPfWngq` |
| Last recorded deployment slot | `505480906` |

[View the program in Solana Explorer](https://explorer.solana.com/address/AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL?cluster=devnet).

## Upgrade the program

```bash
anchor build
anchor test --skip-deploy
anchor program deploy --no-idl
```

`target/deploy/tidebook-keypair.json` determines the program ID. It is ignored
by Git and must be backed up securely. Replacing it creates a different program
address.

The `--no-idl` flag avoids a failure in the separate Anchor metadata upload.
The deployed program is valid; the app uses the local IDL from `anchor build`.

## Web faucet

The devnet faucet is a Next.js server route. Its key controls the two valueless
test mints and stays in server-side environment configuration.

Setup:

1. Create a faucet keypair and fund it with a small amount of devnet SOL.
2. Configure the mint addresses, claim amounts, and claim window from
   `app/.env.example`.
3. Transfer both mint authorities to the faucet public key.
4. Store `FAUCET_AUTHORITY_SECRET_KEY` in encrypted Vercel settings.
5. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
6. Deploy the app and make a claim from a test wallet.
7. Repeat the claim and confirm that rate limiting returns HTTP `429`.

The production Vercel route fails closed without Redis. The in-memory limiter
is only for local development.

Public mint and transaction addresses belong in
[`devnet-addresses.md`](devnet-addresses.md). Never put a seed phrase or private
key in that file.

The on-chain `TestFaucet` PDA is a separate experiment. A mint can be controlled
by the server faucet or the PDA faucet, not both.

## IDL upload issue

Anchor deploys the executable before running its metadata upload. The metadata
step currently invokes `@solana-program/program-metadata` without its required
`@solana/kit` peer dependency and fails with `Cannot find module
'@solana/kit'`.

Until that packaging issue is fixed, deploy with `--no-idl` and use the IDL
generated locally.
