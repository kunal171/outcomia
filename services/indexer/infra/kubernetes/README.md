# Local Kubernetes runtime

Run PostgreSQL and one Tidebook indexer in Kind. This is a local development
setup, not a cloud deployment or a highly available database.

## Files and connections

| File                        | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `kind-config.yaml`          | Creates the local Kind cluster; not part of Kustomize            |
| `namespace.yaml`            | Creates the `tidebook` namespace                                 |
| `postgres-statefulset.yaml` | Runs PostgreSQL and requests persistent storage                  |
| `postgres-service.yaml`     | Gives PostgreSQL the cluster DNS name `postgres`                 |
| `indexer-configmap.yaml`    | Supplies non-secret RPC, program and health settings             |
| `indexer-deployment.yaml`   | Runs the indexer, waits for PostgreSQL and defines health probes |
| `indexer-service.yaml`      | Exposes the health port inside the cluster                       |
| `kustomization.yaml`        | Applies the namespace and workload resources together            |

Service selectors match pod labels. The indexer connects to `postgres:5432`,
not the host's Compose port. Credentials come from two Secrets that are not
checked into Git. The image name in the Deployment points to a built container
image; Kubernetes does not run the Dockerfile.

## Create the cluster and load the image

From the repository root, create the cluster if it does not already exist:

```bash
kind create cluster --name tidebook \
  --config services/indexer/infra/kubernetes/kind-config.yaml
kubectl --context kind-tidebook get nodes
```

Build and load the image:

```bash
docker build --tag tidebook-indexer:dev services/indexer
kind load docker-image tidebook-indexer:dev --name tidebook
```

The Deployment uses `IfNotPresent`, so the local image must be loaded before
starting the workload. When rebuilding the same `dev` tag, load it again and
restart the Deployment.

## Configure and start

These commands target `kind-tidebook`. Replace `<local-password>` with a local
development password; URL-encode it in `DATABASE_URL` if necessary. Create the
Secrets once, or update existing Secrets rather than rerunning their creation.

```bash
kubectl --context kind-tidebook create namespace tidebook \
  --dry-run=client -o yaml | kubectl --context kind-tidebook apply -f -

kubectl --context kind-tidebook -n tidebook create secret generic postgres-credentials \
  --from-literal=POSTGRES_DB=tidebook_indexer \
  --from-literal=POSTGRES_USER=tidebook \
  --from-literal=POSTGRES_PASSWORD='<local-password>'

kubectl --context kind-tidebook -n tidebook create secret generic indexer-secrets \
  --from-literal=DATABASE_URL='postgres://tidebook:<local-password>@postgres:5432/tidebook_indexer'

kubectl --context kind-tidebook apply -k services/indexer/infra/kubernetes
kubectl --context kind-tidebook -n tidebook rollout status statefulset/postgres --timeout=180s
kubectl --context kind-tidebook -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

Review the ConfigMap before applying. It currently uses public devnet RPC and
program `AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL`. If your RPC URL includes
an API key, put it in `indexer-secrets` instead of committing it to the ConfigMap.
The indexer runs migrations before ingestion.

## Verify

```bash
kubectl --context kind-tidebook -n tidebook get pods,services,persistentvolumeclaims
kubectl --context kind-tidebook -n tidebook logs deployment/tidebook-indexer -c indexer --tail=100
kubectl --context kind-tidebook -n tidebook port-forward service/indexer-health 8081:8080
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8081/health/live
curl --fail http://127.0.0.1:8081/health/ready
```

Liveness confirms the health server is running. Readiness additionally checks
that catch-up completed and PostgreSQL can be queried; it is not a live lag
measurement. Event coverage is described in the [indexer README](../../README.md).

After loading a rebuilt image:

```bash
kubectl --context kind-tidebook -n tidebook rollout restart deployment/tidebook-indexer
kubectl --context kind-tidebook -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

## Recovery

Delete the indexer pod and wait for its replacement:

```bash
kubectl --context kind-tidebook -n tidebook delete pod -l app.kubernetes.io/name=tidebook-indexer
kubectl --context kind-tidebook -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

To check PostgreSQL persistence, record row counts and the PVC UID, delete only
`postgres-0`, then compare after it restarts:

```bash
kubectl --context kind-tidebook -n tidebook exec postgres-0 -- \
  psql -U tidebook -d tidebook_indexer -c 'SELECT count(*) FROM chain_transactions;'
kubectl --context kind-tidebook -n tidebook get pvc data-postgres-0 -o jsonpath='{.metadata.uid}'
kubectl --context kind-tidebook -n tidebook delete pod postgres-0
kubectl --context kind-tidebook -n tidebook rollout status statefulset/postgres --timeout=180s
```

Repeat the count/UID checks. With ingestion active, counts may increase; they
should not reset. Do not delete the PVC or Kind cluster during this test: their
removal can destroy this local database. A surviving PVC is not a backup.
