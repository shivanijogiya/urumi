# ADR 007 — Duo flows: dispatch by assignment from CI, goal = an iid

Status: proposed (needs Aadi: new CI variable `DUO_DISPATCH_TOKEN`, flows to re-paste) · Issue #27
· Requirement H4 · Amends ADR 004 (flow triggers, incident issue created by CI) and ADR 005
(postmortem trigger)

## Context

Facts checked live on GitLab on 21 Oct 2026, after the three custom flows in `.gitlab/flows/`
were registered and enabled in project 87777765
(`gitlab-ai-hackathon/transcend-october-2026/36848717/showcase`):

- GitLab creates **one trigger per flow**. The only event types offered are **Mention**,
  **Assign** and **Assign reviewer** of the flow's service account. There is no "pipeline
  failed", "MR created" or "MR approved" event, which ADR 004 and ADR 005 relied on.
- Each flow has its own service account in the project: `ai-canary-incident-gitlab-ai-hackathon`
  (user 43587207), `ai-release-risk-gate-gitlab-ai-hackathon` (43587203) and
  `ai-canary-postmortem-gitlab-ai-hackathon` (43587198).
- Live session 9814505 (risk gate, started by adding its account as reviewer on !31):
  `context:goal` was just the string `"31"`. The prompts expected a webhook payload, so the agent
  did not know the project and failed closed (high risk, paused at Human review). The runner did
  have more context items (`resource_type`, `resource_id`, `resource_web_url`, `pipeline_id`,
  `event_type=assign_reviewer`; `.hermes/ref/live-session-context.txt`), but we know of no flow
  input path that exposes them to a component.

## Decision

- **The goal is an iid, the project is fixed.** Every prompt names project 87777765 and its
  path, treats `context:goal` as the iid of the MR (risk gate, postmortem) or issue (incident)
  whose event started the flow, and extracts the first iid from a bare number, `!N` / `#N`, a
  URL or mention text. No iid: the flow stops with a clear final answer and changes nothing.
  Agents act only on project 87777765. Only `context:goal` is used.
- **CI starts the flows by assigning their accounts** (`scripts/duo/dispatch.py`, stdlib,
  `.gitlab/ci/duo-dispatch.gitlab-ci.yml`, token `DUO_DISPATCH_TOKEN`):
  - `duo:risk-gate` (stage `.pre`, every MR pipeline) adds the risk-gate account to the MR's
    reviewers, keeping the others, and does nothing if it is already one. The flow reads the MR
    and its diffs, applies the `risk.py` globs, posts the note and labels, and pauses at Human
    review for high risk, as before.
  - `duo:incident` (default branch, `when: on_failure` after `canary`) reads the canary's
    `verdict.json` artifact. On decision ROLLBACK it opens the issue
    `Incident: canary rolled back <short sha> (pipeline <id>)` (labels `incident`,
    `priority::high`, `status::ready`; a summary, the metrics table, the reasons, links, and the
    record as a fenced JSON block after the line `CANARY_VERDICT_JSON:`), then assigns the
    incident account in a separate update, so the change is an Assign event. If an open
    incident for the same pipeline exists, it only assigns. `duo:incident:bad-release` does the
    same after the manual `canary:bad-release` drill on main. That job is `allow_failure`, and
    an allowed failure does not trigger `on_failure`, so the job runs `when: always` and
    `dispatch.py` acts only on ROLLBACK.
  - Without the token, `dispatch.py` prints `DUO_DISPATCH_TOKEN not set; skipping Duo
dispatch` and exits 0. Every dispatch job is `allow_failure`, so dispatch never blocks a
    pipeline. Each HTTP call has a 15 s timeout, and errors name the method, path and status,
    never the headers.
- **The incident is the CI's issue, the flow enriches it.** `incident.yaml` no longer triages a
  payload. The investigator checks that the assigned issue is open, labelled `incident` and
  titled `Incident: canary rolled back...`, parses the record block, reads the failed canary
  job's log and the commits between `baseline.stable_sha` and `ci.commit_sha`, opens the
  `priority::high` regression issue, posts `## Incident triage (Duo)` on the incident, and
  labels it `status::triaged` (which replaces `status::ready` and makes a second assignment a
  no-op). The healer is unchanged in its limits (at most 3 files, never CI, charts, secrets or
  `.gitlab/**`, "needs human" when unsure). It reads the incident from the same issue and
  compares against the stable baseline instead of the push's `before_sha`.
- **The postmortem stays a deliberate human step.** After approving an autoheal MR, a person
  mentions `@ai-canary-postmortem-gitlab-ai-hackathon` on it. The flow extracts the MR iid (or
  says that none was given), and verification and postmortem logic are as in ADR 005. CI never
  dispatches it.

## Alternatives

- **Webhook to an external agent** (a small service receives pipeline/MR webhooks and calls the
  Duo API or the flow trigger API). That gives real "pipeline failed" and "MR approved" events,
  but it needs a hosted endpoint, its own secret handling and uptime, and the flows would no
  longer run on GitLab's triggers alone. It is too much for the hackathon scope.
- **Manual mention only** (a person mentions the right account each time). No token is needed,
  but the incident and the risk gate would depend on someone remembering. The incident must
  exist before anyone can mention the bot, and it would lose the data CI has (the verdict
  record). We keep this only for the postmortem, where a human decision is the point.
- **Read the runner's resource context items** (`resource_id`, `pipeline_id`). That would give
  richer input than the goal, but we know of no documented input path for components, so we
  don't depend on it.

## Consequences

- A **project access token** with `api` scope and the **Developer** role is needed as the masked
  CI/CD variable `DUO_DISPATCH_TOKEN`. MR pipelines need it, so it is **not protected**: anyone
  who can push a branch and edit CI can use it. Keep it Developer-only, `api` scope, with a
  short expiry, and rotate it after the hackathon. Fork MR pipelines don't get it and skip.
- **Bot as actor is unverified.** CI acts as the token's bot user. ADR 004 noted that
  triggers fire only on actions that a person started. If GitLab ignores assignments made by
  bot users, the dispatch jobs succeed but no session starts. The fallback is to assign or
  mention the account by hand (the demo steps say how). Check this on the first real run.
- The risk gate runs once per MR (when the account first becomes a reviewer), not on every
  push. Later pushes are still classified by `risk:classify`, and `release:human-approval`
  still gates in CI. To re-run the flow, remove the account as a reviewer and run a pipeline,
  or re-request its review.
- The flows changed shape: re-paste all three YAMLs and Enable them. Triggers are created
  automatically.
- The incident record lives in the issue description. Anyone who can edit the issue can change
  it, so the flows treat it as untrusted data, check types, and use only the documented fields.
