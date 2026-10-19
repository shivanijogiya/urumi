---
name: e2e-flow
description: Write or run the end-to-end demo flows D1–D8 against the local cluster. Use when a task mentions e2e, a D-step (D1…D8), acceptance against the running system, or the checkpoint.
argument-hint: "[D1..D8|all]"
---

# End-to-end flows

Target: $ARGUMENTS

`tests/e2e/run.sh <D1..D8|all>` runs each flow as a script against `http://store.localtest.me` and `http://app.localtest.me`. Each step is a file `tests/e2e/dN-<name>.sh` (bash + curl + jq) or `.ts` (if browser/MCP client needed). Exit 0 = pass. Print one line `PASS Dn` or `FAIL Dn: <reason>`.

| Step | What the script proves |
|---|---|
| D1 | Create a cart order through the WooCommerce Store API with COD; order visible via admin REST API |
| D2 | As User A (session): chat creates a named, priced product → visible in store API; then place an order; chat "orders today" returns it |
| D3 | As User B with only gateway URL + key: MCP `tools/list` shows enabled tools; `woo__list_orders` succeeds |
| D4 | One chat prompt that calls tools from two different upstreams; response lists both tool calls |
| D5 | Revoke User B's key via admin API; next MCP call → 401 |
| D6 | Disable an upstream; its tools disappear from `tools/list` and from the chat tool set |
| D7 | `kubectl delete pod` (or scale to 0) the in-cluster second upstream; other tools still work; status endpoint shows it `down` |
| D8 | Audit API returns every call made above with correct user, server, tool, duration, outcome |

## Rules
- Seed users and keys through the admin API in `tests/e2e/seed.sh`, never by writing to the DB.
- Each step cleans up or is idempotent so `run.sh all` can run twice in a row.
- Chat steps (D2, D4) call the real Claude API; keep prompts short and deterministic ("Use the tools. Reply with only the order ids.").
- No secrets in scripts: read keys from env or from seed output files under `tests/e2e/.out/` (gitignored).
- Report the exact PASS/FAIL lines.
