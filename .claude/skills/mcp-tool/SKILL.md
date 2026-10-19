---
name: mcp-tool
description: Add or change a tool on the WooCommerce MCP server (list/create products, list/get orders, update order status). Use when working in apps/woo-mcp or when a task mentions an MCP tool, its schema, or its tests.
paths: apps/woo-mcp/**
argument-hint: "[tool_name] [issue]"
---

# Adding a WooCommerce MCP tool

Task: $ARGUMENTS

## Shape of every tool
- Defined with the official MCP TypeScript SDK on the Streamable HTTP server in `apps/woo-mcp/src/server.ts`.
- Input schema with zod: every field typed, required vs optional explicit, sensible limits (e.g. `per_page` 1–100, default 20).
- Description: one sentence saying what it does and what it returns. No instructions to the model.
- Calls the WooCommerce REST API (`/wp-json/wc/v3/...`) through `src/woo-client.ts` only — never fetch directly from the tool.
- Every request has a 10 s timeout. Map errors to the shared error envelope from `packages/contracts` (`{ code, message }`), never leak URLs, credentials, or stack traces.
- Return compact JSON: only the fields a user needs (ids, names, prices, status, totals, dates), not the raw WooCommerce payload.

## Required tools (W2)
| Tool | Notes |
|---|---|
| `list_products` | search, pagination |
| `create_product` | name, regular_price (string), optional description, status default `publish` |
| `list_orders` | filters: status, `date` (YYYY-MM-DD, Asia/Kolkata) or after/before; pagination |
| `get_order` | by id; 404 → `NOT_FOUND` |
| `update_order_status` | id + status from the allowed WooCommerce set; reject anything else |

## Tests (write first)
- `apps/woo-mcp/test/<tool>.test.ts`: schema validation (good + bad input), happy path against a mocked WooCommerce HTTP boundary, error mapping (404, 401, timeout).
- Contract test: tool appears in `tools/list` with the expected input schema.

## Security
- Requests must carry the shared-secret header from env `WOO_MCP_SHARED_SECRET`; reject with 401 otherwise. Health endpoint is exempt.
- WooCommerce credentials come only from env (`WOO_URL`, `WOO_USER`, `WOO_APP_PASSWORD`).
