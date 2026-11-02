# Local Kubernetes Setup

These manifests run the indexer and PostgreSQL in a local Kind cluster.

## Files

```text
kind-config.yaml                   creates the Kind cluster
kustomization.yaml                 applies the files below
namespace.yaml                     creates the tidebook namespace
postgres-statefulset.yaml          runs PostgreSQL and creates its PVC
postgres-service.yaml              gives PostgreSQL the DNS name postgres
indexer-configmap.yaml             stores public runtime settings
indexer-deployment.yaml            runs the indexer and its health probes
indexer-service.yaml               exposes indexer health inside the cluster
```

Two Secrets are created by command and are not stored in Git:

- `postgres-credentials`: PostgreSQL database, user, and password.
- `indexer-secrets`: the indexer's `DATABASE_URL`.

Kubernetes connects Services to pods through matching labels. The indexer uses
`postgres:5432`, where `postgres` is the Service name.

## Build and load the image

```bash
docker build --tag tidebook-indexer:dev services/indexer
kind load docker-image tidebook-indexer:dev --name tidebook
```

The Deployment uses `imagePullPolicy: IfNotPresent`, so Kind runs the image
loaded into its node instead of trying Docker Hub.

## Create local Secrets

Create the namespace first:

```bash
kubectl create namespace tidebook --dry-run=client -o yaml | kubectl apply -f -
```

Create the database credentials:

```bash
kubectl -n tidebook create secret generic postgres-credentials \
  --from-literal=POSTGRES_DB=tidebook_indexer \
  --from-literal=POSTGRES_USER=tidebook \
  --from-literal=POSTGRES_PASSWORD='<local-password>'
```

Create the indexer connection string with the same password:

```bash
kubectl -n tidebook create secret generic indexer-secrets \
  --from-literal=DATABASE_URL='postgres://tidebook:<local-password>@postgres:5432/tidebook_indexer'
```

Do not commit real Secret values.

## Apply

```bash
kubectl apply -k services/indexer/infra/kubernetes
kubectl -n tidebook rollout status statefulset/postgres --timeout=180s
kubectl -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

Check the resources and indexer log:

```bash
kubectl -n tidebook get pods,services,persistentvolumeclaims
kubectl -n tidebook logs deployment/tidebook-indexer -c indexer --tail=100
```

## Health checks

Forward the health Service:

```bash
kubectl -n tidebook port-forward service/indexer-health 8081:8080
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8081/health/live
curl --fail http://127.0.0.1:8081/health/ready
```

`live` checks that the process is running. `ready` also checks catch-up state
and PostgreSQL connectivity.

## Recovery checks

Delete the indexer pod and wait for the Deployment to replace it:

```bash
kubectl -n tidebook delete pod -l app.kubernetes.io/name=tidebook-indexer
kubectl -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

Delete the PostgreSQL pod and wait for the StatefulSet to replace it:

```bash
kubectl -n tidebook delete pod postgres-0
kubectl -n tidebook rollout status statefulset/postgres --timeout=180s
```

Check that indexed data remains:

```bash
kubectl -n tidebook exec postgres-0 -- \
  psql -U tidebook -d tidebook_indexer \
  -c 'SELECT count(*) FROM chain_transactions;'
```

Do not delete the `data-postgres-0` PVC during this test. The local recovery
test completed successfully on 2026-11-01: both pods returned to Ready and the
database kept the same records and PVC.
