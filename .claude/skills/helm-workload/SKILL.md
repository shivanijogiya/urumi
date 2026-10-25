---
name: helm-workload
description: Add or change a Kubernetes workload in the Helm chart (Deployment/StatefulSet, Service, Ingress, NetworkPolicy, Secret refs, values). Use when working in charts/ or when a task mentions Helm, Kubernetes, probes, PVCs, ingress, or NetworkPolicy.
paths: charts/**
---

# Helm workload checklist

One chart: `charts/platform`. Every component is a template group under `templates/<component>/`, toggled by `values.<component>.enabled`.

## Every workload must have
- `resources.requests` and `resources.limits` (from values, sane defaults).
- `readinessProbe` and `livenessProbe` (HTTP `/healthz` for our apps; TCP or exec for MariaDB/Postgres).
- Labels: `app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/component`.
- `securityContext`: `runAsNonRoot: true` where the image allows, `allowPrivilegeEscalation: false`.
- Image and tag from values (`image.repository`, `image.tag`), never hardcoded.

## Secrets
- Reference Secrets via `secretKeyRef`. Never put a secret value in `values*.yaml`.
- Local: `scripts/cluster-up.sh` creates secrets from a gitignored `.env.local`. Prod: created out-of-band (documented in README).

## State
- MariaDB, WordPress `wp-content`, and Postgres use PVCs (`persistence.size`, `persistence.storageClass` in values). StatefulSet for databases.

## Networking
- Ingress only for `store` and `app` (dashboard + gateway). Hosts from values: local `store.localtest.me` / `app.localtest.me`.
- `woo-mcp`: ClusterIP only, **no Ingress**, plus a NetworkPolicy allowing ingress only from pods labeled `app.kubernetes.io/component: gateway`.
- The namespace is default-deny for ingress AND egress (`templates/networkpolicy/`, ADR 009). A new workload or flow needs its own allow policy there; `tests/infra/chart-checks.sh` fails if a workload has none. Verify live with `tests/infra/netpol-default-deny.sh`.

## Values files
Any new key goes into `values.yaml` (defaults) and is overridden where needed in **both** `values-local.yaml` and `values-prod.yaml`. Same templates for both environments (K2).

## Verify before finishing
```
helm lint charts/platform
helm template urumi charts/platform -f charts/platform/values-local.yaml > /tmp/out.yaml
helm upgrade --install urumi charts/platform -f charts/platform/values-local.yaml --wait --timeout 5m
kubectl get pods -A
```
Report the actual output. Any change to values, RBAC, NetworkPolicy, Secrets, or Ingress needs Aadi's G3 approval; say so in the report.
