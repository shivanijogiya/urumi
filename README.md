# Urumi MCP Gateway

Transcend Hackathon Showcase workspace for @aadi1012 (DevPost: 1012aaditya).

Urumi is a Kubernetes-hosted WooCommerce store plus a team MCP gateway. An admin registers MCP
servers once; team members then reach every enabled tool through a single authenticated gateway
URL — from an external MCP client or from the React dashboard's chat agent. The gateway handles
team identity, roles, per-user revocable API keys, upstream credential isolation, and an audit log
of every tool call. Everything ships as one Helm chart that runs on local k3d and on a VPS with
different values files.

## Layout

```
apps/woo-mcp/        WooCommerce MCP server (TypeScript, Streamable HTTP, internal-only)
apps/gateway/        MCP gateway + admin API + chat agent backend (TypeScript, Postgres)
apps/dashboard/      React + Vite admin/member UI and chat panel
packages/contracts/  Shared types: gateway API, DB schema, tool naming, error envelope
charts/platform/     The one Helm chart; values-local.yaml, values-prod.yaml
tests/e2e/           D1–D8 scripted flows (run.sh <step|all>)
scripts/             cluster-up.sh, gitlab-setup.sh, create-issues.sh, dev-setup.sh
docs/                Requirements, plan, design, threat model, ADRs
```

## Quick start

Requires Node.js 22.13 or newer (`nvm use` picks up `.nvmrc`).

```sh
npm install          # installs all workspaces
npm test             # unit + contract tests in every workspace
npm run lint         # eslint + prettier --check
npm run typecheck    # tsc --noEmit in every workspace
```

Requirements and design notes live in [`docs/`](docs/) — start with
[`docs/ASSIGNMENT_ANALYSIS.md`](docs/ASSIGNMENT_ANALYSIS.md).

## Local cluster

Requires Docker (Docker Desktop with ~6 GB RAM is enough), `k3d` v5, `kubectl`, and `helm`
(`scripts/dev-setup.sh` installs them).

```sh
scripts/gen-env.sh            # .env.local with random secrets (gitignored, mode 600)
scripts/cluster-up.sh         # k3d cluster `urumi` + registry + namespace + Secret; safe to re-run
scripts/smoke-ingress.sh      # prints PASS ingress / PASS networkpolicy
scripts/cluster-down.sh --yes # delete the cluster (add --all to delete the registry too)
```

- **URLs:** ingress hosts use `*.localtest.me`, a public DNS name that resolves to
  `127.0.0.1` — no `/etc/hosts` edits. k3s's built-in Traefik serves them on ports 80/443,
  e.g. `http://store.localtest.me`, `http://app.localtest.me`.
- **Port 80 busy?** Create the cluster with `HTTP_PORT=8080 scripts/cluster-up.sh` (and
  `HTTPS_PORT=8443` if needed), then use `http://<host>.localtest.me:8080` and run
  `HTTP_PORT=8080 scripts/smoke-ingress.sh`. Ports are fixed at creation; run
  `cluster-down.sh --yes` first to change them.
- **Secrets:** `.env.example` documents every variable. `scripts/secrets-apply.sh` (called by
  `cluster-up.sh`) loads `.env.local` into the Secret `urumi-env` in namespace `urumi`. Re-run it
  after editing `.env.local`, e.g. to add `ANTHROPIC_API_KEY`.
- **Images:** push to the local registry from your machine, and reference it in-cluster by its
  registry name:
  ```sh
  docker tag my-image:dev localhost:5005/my-image:dev && docker push localhost:5005/my-image:dev
  # image: k3d-urumi-registry.localhost:5005/my-image:dev
  ```
- **NetworkPolicy:** k3s's embedded NetworkPolicy controller stays enabled; the smoke test proves
  a default-deny policy really blocks traffic.
- Scripts pin `kubectl` to the `k3d-urumi` context, so they never touch another cluster.
  `CLUSTER_NAME` overrides the name.

### Store chart

`charts/platform` is the one Helm chart. It currently runs the store: MariaDB (StatefulSet) and
WordPress (official apache image), each on its own PVC, with WordPress behind a Traefik Ingress.

```sh
helm upgrade --install urumi charts/platform -n urumi -f charts/platform/values-local.yaml --wait
curl -sI http://store.localtest.me   # 302 to /wp-admin/install.php until WordPress is installed
tests/infra/chart-checks.sh          # offline: probes + requests/limits on every container, no Secret rendered
tests/infra/persistence.sh           # writes DB + wp-content markers, deletes both pods, checks they survive
```

- **Secrets:** the chart never creates a Secret. It reads `MARIADB_PASSWORD` and
  `MARIADB_ROOT_PASSWORD` from the existing Secret named by `secretName` (default `urumi-env`).
  Locally `cluster-up.sh` creates it; in prod create it out-of-band before installing.
- **Data:** MariaDB keeps `/var/lib/mysql` on PVC `data-urumi-mariadb-0`; WordPress keeps its whole
  docroot (core, `wp-config.php`, `wp-content`) on PVC `urumi-wordpress-wp-content`. Both PVCs
  survive pod restarts and `helm uninstall`; delete them by hand to start fresh.
- **Prod:** `values-prod.yaml` uses the same templates with a placeholder host
  (`store.example.com`), the cluster's default StorageClass, and a TLS block that is off until a
  certificate Secret exists.
- Components are toggled with `mariadb.enabled` / `wordpress.enabled`.

## License

[MIT](LICENSE)
