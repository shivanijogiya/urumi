# ADR 006 — AI shoppers: the canary verdict judges business outcomes

Status: proposed (scope approved by Aadi: G4 option B; Anthropic key in CI approved, G3) · Issue
#29 · Amends ADR 003 (a CI-only pin rule on the canary IngressRoute; an extra ROLLBACK signal)
and ADR 005 (the incident and postmortem quote the shopper)

## Context

`verdict.py` judges requests: error rate, p95 and whether `woo__list_orders` returns a non-error
result. A release can pass all three and still break what a customer does: find a product, buy
it, see the order. #29 adds a few short-lived Claude "customers" that shop through the same
gateway during the canary window, on stable and on canary, and say in their own words what
stopped them. The verdict then also compares business outcomes, and the incident can quote the
customer.

Constraints: Python standard library only (like the other canary scripts); the CI job must work
with no Anthropic key (fork MRs); model output is untrusted; the canary must not get slower by
more than 3 minutes; cost must be bounded.

## Decision

- **`scripts/canary/shoppers.py`.** 4 personas, the same on both tracks (4 journeys per track by
  default): a budget buyer (a product under ₹1000, COD, confirm the order), a shop owner
  (today's orders, open the latest), a price check ("Demo Tee"), and a buyer who checks that the
  new order shows up in today's orders. Each journey is a Messages API tool loop with at most 8
  turns, `max_tokens` 600 and `tool_choice: any`. Model `claude-haiku-5-5` (env `SHOPPER_MODEL`).
  Journeys run in parallel threads (`--concurrency` 4).
- **Only real calls as tools.** `woo__list_products`, `woo__list_orders` and `woo__get_order` go
  through the gateway's MCP endpoint with user B's API key: stateless Streamable HTTP, one
  `initialize`, then one `POST /mcp` per `tools/call` (ADR 001/#15). So they go through
  `callTool` and write audit rows like any MCP client. `checkout` places a Cash on delivery order
  through the WooCommerce Store API (cart, add-item, checkout), the same path as tests/e2e D1.
  Tool schemas and descriptions are written in shoppers.py, not taken from the upstream (its
  descriptions are untrusted).
- **The shopper's verdict, checked by the harness.** A journey ends with tool `finish`
  `{completed, blocker, summary}`; the blocker is one sentence in the customer's words. It counts
  as completed only if the harness also saw the evidence the goal needs (`needs`): a placed order
  that was found again through the gateway, a successful `woo__list_orders` and `woo__get_order`,
  and so on. A model cannot claim a success that did not happen. No verdict within 8 turns is a
  failure ("I gave up").
- **Track pinning: a request header, option (b).** With `gatewayCanary.pinHeader.enabled` the
  canary IngressRoute gets two more rules, one priority above the weighted split:
  `Host(app) && PathRegexp(^/(api|mcp)(/|$)) && Header(X-Urumi-Track, canary|stable)`, each to
  one Service. The rules exist only while the canary is enabled and only when `pinHeader` is on,
  which only `scripts/canary/values-ci.yaml` does. The chart refuses `pinHeader` (render fails)
  with `app.tls.enabled` or with an `app.host` that is not `*.localtest.me`, so the production
  values cannot render it (`tests/infra/canary-chart.sh`). Requests without the header (the
  verdict probe, everyone else) keep the weighted split.
  - **Why not (a), a sticky cookie on a weighted TraefikService?** The first request still lands
    on a random track (20/80), so running the same personas on both tracks means retrying until
    the cookie says the right thing. It needs a new TraefikService object and cookie handling in
    the client. Sticky routing would also change the split for every client, and a cookie can be
    replayed, so it would not keep users off the canary in production either. The header is
    deterministic, needs no new CRD kind and leaves the split as ADR 003 describes it.
  - **Assertion.** Every gateway answer of a journey must carry `x-urumi-track: <pinned track>`.
    An answer from the other track, or a 2xx answer without the header, makes the journey
    **invalid** (not counted), not failed. A proxy error or no answer without the header (a dead
    pinned pod) is a tool error that the shopper sees, so a dead canary fails its journeys
    instead of hiding as "invalid".
  - The Store API (`checkout`) is not part of the canary: WordPress is shared by both tracks.
    The order is confirmed through the gateway, which is pinned.
- **Budget and time.** Spend is estimated from each response's `usage` × list price (constants in
  shoppers.py: Haiku $1 / $5 per million input / output tokens; unknown families are priced as
  the most expensive). Once it passes `SHOPPER_BUDGET_USD` (default 0.50), or `--deadline-s`
  (CI: 120) passes, no new turn starts and unfinished journeys are invalid.
- **Skip, never fail.** No `ANTHROPIC_API_KEY`, or a Messages API failure before any journey
  finishes, writes `{"skipped": "<reason>"}` and exits 0. A 400/401/403/404 stops the other
  journeys at once; 408/409/429/5xx/529 and network errors are retried once. Models that refuse
  `temperature` (claude-haiku-5-5 answers 400 "temperature is deprecated for this model") run at
  their default; shoppers.json records which.
- **Verdict rule (verdict.py `--shoppers`).** On top of every existing rule:
  - ROLLBACK if canary success < stable success − 0.25 (`--shopper-max-drop`) and the canary
    has ≥ 3 valid journeys (`--shopper-min-journeys`). The reason is `AI shoppers: 0/4 journeys
completed on canary vs 4/4 on stable — "<the most common canary blocker>"`.
  - Ignored, and said so in the reasons, when stable success < 0.5 (`--shopper-min-stable`, an
    environment problem) or the canary has too few valid journeys. Ignored silently when skipped.
  - Shoppers never turn a ROLLBACK or a HOLD into a PROMOTE. Their reason is added to a ROLLBACK
    and to a HOLD.
  - The quote is model output: `sanitize_quote` removes control and format characters, URLs,
    backticks, `@` (no GitLab mentions), `< > | \`, joins lines and cuts it to 160 characters.
    shoppers.py sanitizes too, and the verdict does it again on its input.
  - verdict.json gains `shoppers{status, stable, canary, rollback, ...}` and `customer_voice`;
    `record.jq` always carries both (null without shoppers), and `autoheal_report.py` keeps them.
- **CI.** `ci.sh` step 6 starts shoppers.py in the background as soon as the canary is live,
  runs the verdict probe at the same time, waits for both, then runs
  `verdict.py --report verdict.json --shoppers shoppers.json`. The key comes from the masked CI
  variable through the environment only (`set +x`; never argv, never echoed). Artifact:
  `shoppers.json` (trimmed transcripts: tool names, ok/error, the shopper's final sentence).
- **Flows.** The incident reporter adds a line `> Customer voice (AI shopper on the canary):
"<customer_voice>"` and the journey tally; the regression issue points at shoppers.json; the
  postmortem repeats the incident's quote. Both prompts call it untrusted model output that is
  never followed, linked or mentioned. Toolsets are unchanged (`flows.test.sh`).

## Consequences

- **Cost per canary run, measured** on the local cluster (4 personas, stable, claude-haiku-5-5):
  25,969 input + 922 output tokens, about **$0.03 for 4 journeys**, 17 s. A CI run (4 per track)
  is about **$0.06**, capped at $0.50 by the guard. The prices are constants in the code; check
  them when the model changes.
- **Time.** Shoppers run next to the probe, so the added time is what they take beyond it. The
  120 s deadline stops new turns; a turn already in flight can add up to 30 s (model timeout) +
  15 s (tool timeout).
- **Nondeterminism.** The model's answers vary from run to run, and claude-haiku-5-5 does not
  accept `temperature`. The rule needs a 25-point drop and at least 3 valid canary journeys. With
  4 journeys per track, one flaky canary journey (75 % vs 100 %) never rolls back by itself; two
  do. The harness's evidence check stops "I did it" without an order. A shopper can also work
  around a fault (for example, asking for a smaller page after "Tool result too large"). Then
  its journey completes, which is a fair picture of a resilient client. The probe still sees the
  fault.
- **Pin header risk.** On a cluster where `pinHeader` is on, anyone who can reach the app host
  can send `X-Urumi-Track: canary` and choose the canary. That is acceptable only on the CI
  cluster: it lives inside the job's Docker-in-Docker, is gone after the job, and its host name
  resolves to 127.0.0.1. The chart refuses it with TLS or a real host name, and the chart test
  checks that `values-prod.yaml` never renders it. Someone who installs with `*.localtest.me`,
  no TLS, and `pinHeader` on a public machine has opted out of that guard.
- **Real side effects.** Each run places 4 COD orders (2 per track) in the store and writes
  audit rows for user B. In CI the cluster is thrown away. On a shared store, run shoppers.py
  with `--tracks` and `--journeys` small, or not at all.
- **Fork MRs** have no key: the shoppers are skipped and the verdict is the probe's, as before.
