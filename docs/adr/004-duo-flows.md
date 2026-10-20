# ADR 004 — Duo Agent Platform flows: incident on rollback, risk gate before promote

Status: proposed (needs Aadi: flows are registered in the GitLab UI, and CI semantics change) ·
Issue #24 · Requirement H3 · Amends ADR 003 (a ROLLBACK now fails the canary job)

## Context

H3: a forced rollback opens an incident and a `priority::high` regression issue; an auth/gateway
MR pauses for Human Input before promote; the flow YAML lives in `.gitlab/flows/`. GitLab Duo
custom flows are registered by a Maintainer in the UI (AI > Flows), not loaded from the repo.
Triggers start them on **Pipeline events** (Failed/Passed) or **Merge request** (Created / ready),
and only for actions that a person started. For a pipeline trigger, `context:goal` is the pipeline
webhook payload. Custom flows must be `environment: ambient`, use local prompts without `model`,
and have no top-level `name`/`description`/`product_group`, no response schemas and no
`params.stop`. Agents may only use tools from the Duo tools registry. Our CI token cannot set job
variables, but a person can run pipelines and jobs from the UI.

## Decision

- **A rejected release fails the pipeline.** `scripts/canary/ci.sh` exits 1 with `RELEASE
REJECTED: canary rolled back` after it applies a rollback, and it also fails on HOLD (as before).
  `canary` is not `allow_failure` on the default branch, so a ROLLBACK there fails main's pipeline.
  `canary:bad-release` is manual and not `allow_failure` on main, so clicking it is a
  human-initiated pipeline failure, which is what the trigger needs. MR jobs stay manual and
  `allow_failure`. ADR 003's "the job succeeds when the decision was applied" no longer holds.
- **The log is the interface.** ci.sh prints one `CANARY_VERDICT_JSON: {...}` line: verdict.py's
  report plus `decision`, `force_bad`, `risk`, `canary_weight_pct`, a timeline
  (`canary_live_at`, `verdict_at`, `applied_at`) and CI links (`scripts/canary/record.jq`). The
  flow reads it with `get_logs_from_job`. There is no tool for job artifacts in the registry list.
- **Risk is classified in CI, by path.** `scripts/canary/risk.py` (stdlib, unit-tested) marks a
  change `high` when it touches gateway auth/keys/users/crypto/http/mcp, the SSRF guard, chart
  NetworkPolicies/values/RBAC/Secrets, or the CI definition. If the diff can't be computed, the
  change is `high` (fail closed). The `risk:classify` job (stage test, MR + main) exports dotenv
  `RISK`. A PROMOTE of a high-risk change becomes `DECISION=PROMOTE_PENDING_APPROVAL`: the canary
  is rolled back in the ephemeral cluster and the verdict is recorded.
- **The enforcing human gate is a manual CI job.** `release:human-approval` (stage deploy,
  `when: manual`, `allow_failure: false`) blocks the pipeline until a person runs it. Then
  `scripts/canary/approval.py` writes `approval.json` with the approver (`GITLAB_USER_LOGIN`) and
  the time. A dotenv value can't decide whether a job exists, so on main the job is always
  created and is a no-op when `RISK=low`. On MR pipelines it is created only when `rules:changes`
  matches a high-risk glob. With "Pipelines must succeed", a high-risk MR can't merge until
  someone runs it.
- **Flows explain and record. They don't enforce.**
  - `incident.yaml` (Pipeline Failed): a tool-less `triage` agent answers `incident`/`skip` from
    the payload alone. `skip` ends the flow, and any other answer reaches `incident_reporter`,
    which checks again. That agent confirms the failed `canary`/`canary:bad-release` job and
    reads the verdict line. Only for `decision == ROLLBACK` does it search for an existing
    incident with the same pipeline id, then create the incident and the
    `priority::high`/`type::regression`/`app::gateway` issue and link them. HOLD or a setup
    failure creates nothing.
  - `risk-gate.yaml` (MR Created / ready): applies the same globs, posts one note (risk level,
    matched paths, what to check, "the release will pause at `release:human-approval`"), and
    sets `risk::high` + `gate::infra` or `risk::low`. Any answer other than `low` pauses at a
    `HumanInputComponent` approval, and the decision is posted on the MR.
- **One rule set, checked three ways.** `.gitlab/flows/tests/flows.test.sh` fails if risk.py's
  globs, the risk-gate prompt and the job's `rules:changes` differ. The same test checks the
  custom-flow restrictions and that every tool is in `.gitlab/flows/tool-names.txt` (a copy of
  the registry names we allow).
- **Untrusted input.** Payloads, logs, MR text and diffs are data. The prompts say so, the triage
  step has no tools, the reporter copies only the verdict line, and each agent gets only the
  tools its step needs (least privilege). risk.py reduces paths in its dotenv output to a safe
  character set, so a crafted file name can't inject CI variables.

## Consequences

- A main pipeline sits in **blocked** until someone runs `canary:bad-release` and/or
  `release:human-approval`, because both are manual jobs with `allow_failure: false`. That is
  the price of a one-click, human-initiated drill without CI variables. The alternative is a
  drill job that exists only in pipelines started with "Run pipeline" (`CI_PIPELINE_SOURCE ==
"web"`).
- A forced bad release always fails its job, even when the drill worked. `DECISION` and the log
  tell the two apart.
- The CI cluster is ephemeral. "Promote" means the recorded decision plus the approval record,
  not a deploy to a long-lived environment. Stronger separation of duties (approver ≠ author,
  N approvers) needs a protected environment with deployment approvals (Premium). That is not
  done here.
- Flow behaviour is model-driven: exact-word answers can drift, which is why both conditional
  routes fail toward the safer branch. Tool parameter names (for example an incident issue type,
  or add-labels on `update_merge_request`) are resolved by the agent from the tool schemas at
  run time, and the prompts give fallbacks. Flows need Duo Agent Platform, custom flows turned
  on, and GitLab Credits.
