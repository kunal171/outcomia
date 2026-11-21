# Northflank deployment (free Sandbox)

Runs one indexer service and one PostgreSQL addon on Northflank's free
Sandbox (always on, no card). This is a devnet research deployment, not a
highly available setup. Production has no indexer until these steps are done;
the app falls back to RPC whenever indexed data is unavailable.

```text
Vercel (Next.js) --server-side--> https://<indexer>/graphql, /auth/*  (port 8081, public)
                                   /health/live, /health/ready          (port 8080, private)
indexer --internal--> PostgreSQL addon
indexer --RPC + WebSocket--> Helius devnet
```

## 1. Project and database

1. Create a project in a region close to Vercel's (for example US East).
2. Add a **PostgreSQL** addon: version **18** (matches `compose.yaml`), the
   smallest plan, **TLS off** and **not publicly accessible**. Internal traffic
   stays inside the project; the indexer also supports TLS if you enable it.

## 2. Secret group

Create a secret group named `indexer-runtime`, applied to the indexer service:

| Variable              | Value                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`        | Linked from the addon: select `POSTGRES_URI` and alias it to this name |
| `SOLANA_RPC_URL`      | `https://devnet.helius-rpc.com/?api-key=<your key>`                    |
| `SOLANA_WS_URL`       | `wss://devnet.helius-rpc.com/?api-key=<your key>`                      |
| `OUTCOMIA_PROGRAM_ID` | `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`                         |
| `APP_ORIGIN`          | `https://outcomia-self.vercel.app` (exact; no trailing slash)          |
| `INDEXER_PROXY_SECRET` | 32+ random characters; the same value as on Vercel                   |
| `API_ADDRESS`         | `0.0.0.0:8081`                                                         |
| `HEALTH_ADDRESS`      | `0.0.0.0:8080`                                                         |

Use a dedicated Helius key; the public devnet endpoint rate-limits program
account scans. Keep the `/` before `?` in the WebSocket URL: without it
(`wss://devnet.helius-rpc.com?api-key=...`) the live subscription cannot
connect and readiness never turns ready. `APP_ORIGIN` must be HTTPS outside loopback, and sign-in rejects
requests from any other origin. The indexer needs no wallet or signing key.

## 3. Combined service

Create a **combined service** (build and deploy):

| Setting         | Value                                                        |
| --------------- | ------------------------------------------------------------ |
| Repository      | `kunal171/outcomia`, branch `master`                         |
| Build type      | Dockerfile                                                   |
| Dockerfile path | `/services/indexer/Dockerfile`                               |
| Build context   | `/` (the Dockerfile copies `app/idl/outcomia.json`)          |
| Path rules      | `services/indexer/**` and `app/idl/outcomia.json`, so frontend-only commits do not rebuild |
| Port 8081       | HTTP, **public** (GraphQL and sign-in)                       |
| Port 8080       | HTTP, **private** (health only)                              |
| Readiness probe | HTTP `GET /health/ready` on port 8080                        |
| Liveness probe  | HTTP `GET /health/live` on port 8080                         |
| Resources       | Smallest available plan; 1 instance                          |

A local rehearsal of this exact setup (Postgres 18, `postgresql://` URI,
production `APP_ORIGIN`, Helius devnet) reached readiness within a minute and
used about 8 MB (indexer) and 60 MB (PostgreSQL) of memory at idle, so the
smallest plan is sufficient. Keep one instance: ingestion checkpoints assume
a single writer. Migrations run
automatically on startup. Stop grace should be at least 30 seconds.

If the Sandbox builder cannot finish the Rust release build, build the image
elsewhere (for example a GitHub Actions workflow pushing to GHCR) and point the
service at that image instead; the runtime settings are unchanged.

## 4. Verify the indexer

Replace `<host>` with the public URL of port 8081.

```bash
curl -s -X POST https://<host>/graphql -H 'content-type: application/json' \
  --data '{"query":"{ syncStatus(commitment: \"confirmed\") { ready slot observedAt } }"}'
```

`ready` becomes true once backfill and live catch-up complete. Check the
service logs for backfill progress and the probes for readiness.

## 5. Connect the app

In Vercel (Production and Preview):

- `INDEXER_API_URL=https://<host>`: server-only; never a `NEXT_PUBLIC_` value.
- `INDEXER_PROXY_SECRET`: server-only, identical to the indexer's value, so
  sign-in rate limits apply per browser rather than to the proxy as a whole.
- `NEXT_PUBLIC_INDEXER_ENABLED=true`: build-time flag, so redeploy afterwards.

The same-origin proxy at `/api/indexer/*` forwards only GraphQL and sign-in
paths and keeps session cookies HttpOnly. If the indexer is down or stale,
current-state reads fall back to RPC; history charts and wallet sign-in need it.

## Limits and costs

The Sandbox gives 2 services, 2 jobs and 1 addon, up to about $20/month of
resources, with no sleeping and no card. Its addon storage cap is not
published; devnet history is small, but watch volume usage. The Sandbox is
aimed at testing; move to a paid plan or the Oracle/VM option before relying
on it for anything important.
