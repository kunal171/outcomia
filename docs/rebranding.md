# Outcomia rename

Outcomia is the new project name. The Anchor crate and module are `outcomia`,
the service is `outcomia-indexer`, and the app is `outcomia-app`.

The Solana program address and every PDA seed are unchanged. Renaming source
files does not deploy a program or move funds. Account and instruction
discriminators, error codes, recorded evidence and applied SQL migrations retain
their original bytes. Existing market names are on-chain data, not UI branding.

## Compatibility

- New app installs use `NEXT_PUBLIC_OUTCOMIA_PROGRAM_ID`. The former
  `NEXT_PUBLIC_TIDEBOOK_PROGRAM_ID` remains a fallback for existing deployments.
- The indexer accepts `OUTCOMIA_PROGRAM_ID`, then the former
  `TIDEBOOK_PROGRAM_ID`, then its documented devnet default.
- New preferences use `outcomia_*` cookies. Existing `tidebook_*` cookies and
  sidebar preferences are read as fallbacks.
- Redis faucet counters retain their original namespace so a rename cannot reset
  claim quotas.
- Compose retains the existing database/user and named PostgreSQL volume.
  Its service/image branding changes; its stored data does not. Stop the old
  Compose indexer before starting the renamed stack: only one indexer should
  write checkpoints for a given database/program.
- New Kind/Kubernetes manifests use the Outcomia namespace and image. They do
  not migrate an existing cluster, Secrets or persistent volumes. Export and
  restore the database deliberately if moving workloads to the new namespace.

The original deployment keypair is copied to the ignored
`target/deploy/outcomia-keypair.json` for the renamed build target. It must match
the existing program ID; never generate a replacement as part of branding.
The former keypair is retained as a backup.

The GitHub repository is now [kunal171/outcomia](https://github.com/kunal171/outcomia),
and the local origin uses that URL. Historical repository URLs remain in captured
evidence. Hosting project/domain names are separate Vercel resources; changing
source code does not rename them. Protected local environment files remain intact. Historical Arweave documents and transaction
reports retain their original labels and URLs. Do not rewrite signed evidence to
make its spelling match the new brand.
