# Local Kubernetes Runtime

These manifests run the Tidebook indexer and PostgreSQL in a local Kind
cluster. They are a development reference for the later cloud deployment, not
a production database configuration.

## How the files connect

```text
kind-config.yaml -> local Kind cluster
                         |
namespace.yaml -> tidebook namespace
                         |
postgres-service.yaml -> postgres-statefulset.yaml -> persistent volume
             ^                         ^
             |                         |
             +------ indexer-deployment.yaml
                          ^          |
                          |          v
          indexer-configmap.yaml   indexer-service.yaml
          Kubernetes Secrets      health endpoints

kustomization.yaml applies the namespace and workload manifests together.
```

- `kind-config.yaml` creates the local cluster and is not applied by Kustomize.
- `postgres-statefulset.yaml` owns the PostgreSQL pod and persistent-volume
  claim. `postgres-service.yaml` gives it the stable DNS name `postgres`.
- `indexer-deployment.yaml` runs one indexer, waits for PostgreSQL, loads its
  configuration, and defines startup, readiness, and liveness probes.
- `indexer-configmap.yaml` contains non-secret runtime settings.
- `indexer-service.yaml` exposes the health server inside the cluster.
- `namespace.yaml` isolates all Tidebook resources.
- `kustomization.yaml` is the single entry point for applying the manifests.

The `postgres-credentials` and `indexer-secrets` Secrets are deliberately not
stored in Git. Resource labels connect Services to pods, while the name
`postgres` becomes the database's internal Kubernetes DNS address.

## Deploy locally

Build and load the development image before applying the manifests:

```bash
docker build \
  --tag tidebook-indexer:dev \
  services/indexer

kind load docker-image tidebook-indexer:dev --name tidebook
```

Create the two required Secrets with local development values:

```bash
kubectl create namespace tidebook --dry-run=client -o yaml | kubectl apply -f -

kubectl -n tidebook create secret generic postgres-credentials \
  --from-literal=POSTGRES_DB=tidebook_indexer \
  --from-literal=POSTGRES_USER=tidebook \
  --from-literal=POSTGRES_PASSWORD='<local-password>'

kubectl -n tidebook create secret generic indexer-secrets \
  --from-literal=DATABASE_URL='postgres://tidebook:<local-password>@postgres:5432/tidebook_indexer'
```

Apply and wait for both workloads:

```bash
kubectl apply -k services/indexer/infra/kubernetes
kubectl -n tidebook rollout status statefulset/postgres --timeout=180s
kubectl -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

## Verify

```bash
kubectl -n tidebook get pods,services,persistentvolumeclaims
kubectl -n tidebook logs deployment/tidebook-indexer -c indexer --tail=100
kubectl -n tidebook port-forward service/indexer-health 8081:8080
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8081/health/live
curl --fail http://127.0.0.1:8081/health/ready
```

`live` confirms the process is running. `ready` additionally confirms the
indexer has caught up and can query PostgreSQL.

## Recovery checks

The Deployment should recreate a deleted indexer pod:

```bash
kubectl -n tidebook delete pod \
  -l app.kubernetes.io/name=tidebook-indexer
kubectl -n tidebook rollout status deployment/tidebook-indexer --timeout=180s
```

The StatefulSet should recreate PostgreSQL without losing its PVC data:

```bash
kubectl -n tidebook delete pod postgres-0
kubectl -n tidebook rollout status statefulset/postgres --timeout=180s
kubectl -n tidebook exec postgres-0 -- \
  psql -U tidebook -d tidebook_indexer \
  -c 'SELECT count(*) FROM chain_transactions;'
```

Never delete `data-postgres-0` during this recovery test. Deleting the PVC
removes the persistent-storage guarantee being tested.

The local recovery test on 2026-11-01 recreated both pods successfully. The
database retained 28 source transactions and 25 events, and the PVC UID stayed
unchanged.
