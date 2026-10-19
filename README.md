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

## License

[MIT](LICENSE)
