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

### Store bootstrap

A Helm `post-install,post-upgrade` hook Job (`urumi-bootstrap`, toggle `bootstrap.enabled`) makes
the store usable with no clicks: it installs WordPress, installs WooCommerce (pinned:
`bootstrap.woocommerce.version`), sets INR / Asia/Kolkata / pretty permalinks, enables free
shipping + Cash on delivery, turns off "coming soon", seeds a `Demo Tee` product, and creates the
`woo-mcp` user (role `shop_manager`) with an Application Password. The password lives **only** in
the Secret `urumi-woo-api` (`WOO_URL`, `WOO_USER`, `WOO_APP_PASSWORD`), which the Job writes and
then checks with `GET /wp-json/wc/v3/orders` (must be 200). Re-runs are idempotent and keep a
password that still works.

```sh
kubectl -n urumi logs job/urumi-bootstrap --all-containers   # last run (kept for 1 h)
tests/infra/store-bootstrap.sh   # Secret, REST 200/401, COD, D1 checkout, no secret in logs, re-run
```

- **Why the REST API + Application Password (W4):** it is WooCommerce's supported, versioned
  interface, so its validation, hooks and emails run and the woo-mcp server needs nothing but
  HTTP. WP-CLI needs a shell in the WordPress pod (fine for this one-off Job, not for a
  service), and writing the DB directly skips WooCommerce's logic and breaks with schema changes
  (e.g. HPOS order tables). The Application Password is scoped to one least-privilege user and
  can be revoked without touching the admin login.
- **HTTPS:** WordPress accepts Application Passwords only over HTTPS unless
  `WP_ENVIRONMENT_TYPE` is `local` (`bootstrap.environmentType`: `local` locally, `production`
  in prod). In prod, in-cluster plain-HTTP calls to `WOO_URL` must send
  `X-Forwarded-Proto: https` (the Job does).
- **RBAC:** the Job's ServiceAccount may `get/patch/update` only `urumi-woo-api`, plus `create`
  Secrets in the namespace (Kubernetes cannot scope `create` by name). Only the Job's kubectl
  container gets an API token.
- **Prod:** the Job downloads WooCommerce from wordpress.org, so the cluster needs egress to it.
- **Reset:** `helm uninstall` keeps the last Job and the Secret `urumi-woo-api`. Delete the Job
  (`kubectl -n urumi delete job urumi-bootstrap`) before the PVCs: its finished pod still holds
  the WordPress PVC. A stale Secret is fine; the next run replaces its password.

## License

[MIT](LICENSE)
