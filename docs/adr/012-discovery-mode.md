# ADR 012 — Many tools: discovery mode (search, then execute)

Status: proposed (needs Aadi: new meta-tools, reserved slug, chat behaviour changes above a
threshold) · Brief stand-out item 4 ("Many tools") · Builds on ADR 008 (permissions), 011

## Context

The brief: "Ten servers can mean hundreds of tools … Show an approach, such as tools that search
for and then execute other tools." Today every permitted tool definition goes to the MCP client
and to the chat model on every turn. The admin on the local cluster already sees 62 tools
(GitLab alone has 41). A few hundred definitions cost tens of thousands of tokens per chat turn,
and models choose worse among them.

## Decision

**Two meta-tools** (`src/discovery/meta-tools.ts`), reserved under the slug `gateway`, which
upstreams may no longer take (contracts `RESERVED_SLUGS`, enforced on create):

- `gateway__search_tools(query, limit≤25, default 8)` ranks **only the caller's permitted tools**
  (`listToolsFor`, ADR 008) and returns names, servers, sanitised descriptions and input schemas.
  It runs no upstream tool and is not audited, the same as `tools/list`.
- `gateway__call_tool(name, arguments)` calls **`callTool`**, the one call path: permission check
  (FORBIDDEN, audited `denied`), routing, 15 s timeout, metrics, and an audit row that names the
  **real** server and tool. A meta-tool cannot call a meta-tool.

**Ranking** (`src/discovery/search.ts`): BM25 (k1 1.2, b 0.75) over each tool's server slug and
tool part, which are split on `_`/`-`/camelCase and weighted 3×, plus its description. Stopwords
are dropped and plurals stripped naively. There is a bonus for a query equal to the tool part or
the qualified name, and a small bonus when a query term names the server (`woocommerce` → `woo`).
Only matching tools are returned, ordered deterministically (ties break on name). No embeddings:
no model, no new dependency, no network, instant on hundreds of tools, explainable.

**How MCP clients choose it:** per request with **`/mcp?mode=discovery`**, which works in any client
that only takes a URL (Claude Desktop, Inspector), or with the header `x-urumi-tool-mode: discovery`.
In that mode `tools/list` returns only the two meta-tools. Direct tool names still work in
`tools/call`. An unknown mode gets 400. We chose a per-request option over a stored per-key or
per-user setting: `/mcp` stays stateless (ADR 010) and the same key can serve both kinds of client.

**Chat** switches automatically: when the user's permitted tools exceed
`CHAT_DISCOVERY_THRESHOLD` (`gateway.chatDiscoveryThreshold`, default 40; 0 = always), the model
gets only the two meta-tools and one extra system-prompt line on how to use them. The chat response
reports `toolMode`, the searches (`discoverySearches`: query, match count, top names), and in
`toolCalls` the **real** tools executed (`via: "discovery"`). The chat UI shows a "Discovery mode"
note, the searches, and "Tools executed" with each real tool name.

## Consequences

- Tests: `test/discovery-search.test.ts` (tokenizer; right tool first for 7 queries among 130
  tools; exact names; limit / no match / order-independence; only given tools are returned),
  `test/discovery.test.ts` (SDK client over `?mode=discovery` and the header: 2 meta-tools; search
  finds `synth__refund_payment` among **125** tools; call routes and audits the real tool;
  a member neither finds nor calls `woo__create_product`, which is FORBIDDEN and audited `denied`;
  bad arguments and recursion are refused; the `gateway` slug is refused; chat with a scripted model
  above and below the threshold), `apps/dashboard/test/chat.test.tsx`, contracts naming test.
- e2e **D12** on k3d: 5 synthetic copies of the in-cluster everything server bring the admin to
  **142 tools**. Discovery `tools/list` = 2. "list woocommerce orders" → `woo__list_orders` and
  "sum of two numbers" → `everything__get-sum` come first. `gateway__call_tool` results are audited
  as `woo/list_orders` and `everything/get-sum`. Member B's search excludes
  `woo__create_product` and calling it is FORBIDDEN/`denied`. Admin chat runs in discovery mode
  against the real model (search → `everything__get-sum` via discovery → "42").
- Members on the local cluster have 39–40 permitted tools, right at the default threshold, so the
  D2/D4 chats stay in direct mode. One more member grant switches them to discovery, which then
  costs one extra model round (the search) per new task.
- Keyword search misses synonyms that appear nowhere in a tool's name or description (e.g. "money
  back" vs "refund"). The model can search again; embeddings would fix it at the cost of a model
  dependency.
- Search results include input schemas (≤ 16 KB each, ADR 002 limits); `limit ≤ 25` bounds a
  response.
