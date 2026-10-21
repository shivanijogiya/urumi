# ADR 005 — Self-healing release loop: diagnose, fix MR, verify by canary, postmortem

Status: proposed (needs Aadi: new flow to register, CI semantics change for autoheal MRs and for
the canary baseline) · Issue #28 · Scope G4 option B · Amends ADR 003 (stable baseline, seeded
orders) and ADR 004 (incident flow gains a healer step)

## Context

ADR 004 ends at "a ROLLBACK opens an incident and a regression issue". #28 closes the loop: Duo
diagnoses the rolled-back release, proposes a fix as a merge request, the fix is verified by the
same canary with no human click, a person approves, and Duo writes the postmortem. A person still
merges. Three facts shaped the design:

1. **The CI canary could not see a real regression.** `ci.sh` built stable and canary from the
   same commit, so a code regression broke both tracks and verdict.py answered HOLD ("stable
   itself is unhealthy"), which the incident flow ignores. And the CI store had no orders, so
   the `woo__list_orders {"date":"today"}` probe only ever read a ~250-byte empty page.
2. **The flow tools cannot list a pipeline's jobs.** In the tools we use, jobs are found only
   through `get_pipeline_failing_jobs`, which returns failed jobs. A verified fix has a
   successful `canary` job, so its log is out of reach. `get_logs_from_job` reads any job's log
   once its id is known. The registry also has `GitLabApiGet`, a generic read-only REST tool
   that could list jobs or fetch `verdict.json`, but its tool name and parameters are not in our
   offline references, so we do not depend on it.
3. **Custom flows route on exact answers.** A router compares a component's final answer with
   fixed words; anything else takes `default_route`.

## Decision

- **Canary baseline = the last promoted commit (ci.sh).** Stable's gateway image is built from
  `ci.commit_sha` in `verdict.json` of the latest successful `canary` job on the default branch.
  It is fetched with the job-token artifacts API
  (`/jobs/artifacts/<default branch>/raw/verdict.json?job=canary`). A successful pipeline means
  PROMOTE, or PROMOTE_PENDING_APPROVAL that a person approved. `CANARY_BASE_SHA` overrides it.
  With no baseline (first run, outside CI, API error, commit not in the clone), stable is HEAD,
  as before. The canary job sets `GIT_DEPTH: 0`, and `verdict.json` records
  `baseline {stable_sha, source}`. After a rollback the last promoted commit is still the one
  before the regression, so the autoheal MR's canary compares the fix with what users actually
  run.
- **Realistic probe data.** `scripts/canary/seed-orders.sh` places 24 shopper orders for today
  through the Store API (cart and Cash on delivery, like D1), so the probe reads a 20-order page
  with line items (about 6–9 KB). A seeding failure fails the job as a setup failure (no
  verdict).
- **Incident flow: `healer` after `incident_reporter`.** The reporter's final answer is now
  exactly `healable` or `done`. It answers `healable` only when it created a new incident in this
  run, for a non-drill (`force_bad` false) ROLLBACK on the default branch. The router sends
  `healable` to `healer`, and anything else, a malformed answer included, to `end`, so there is
  no loop and no retry. Pipelines on `autoheal/` branches are skipped by triage and by the
  reporter, so the flow never heals its own fixes. The healer:
  - finds the incident (title plus `Pipeline ID:`), lists the commits since `before_sha`, reads
    the diffs and picks the one suspect that touches `apps/gateway/**`;
  - explains the hunk against the verdict reasons and gives a confidence;
  - prefers a targeted revert of only those hunks, or a full revert of the suspect's files when
    unsure. It creates branch `autoheal/<pipeline id>`, commits, and opens MR
    `Autoheal: <one-line root cause> (incident #N)`, labelled `autoheal`, with the root-cause
    analysis, the verdict table, the exact hunk and the confidence. It links the MR on the
    incident and on the regression issue.
  - **Hard rules** (otherwise it opens no MR and comments "needs human" with its analysis): only
    files changed by the suspect commit, at most 3; never `.gitlab-ci.yml`, `.gitlab/**`,
    `charts/**`, `scripts/canary/**`, Dockerfiles, package manifests or secret/key/credential/env
    files; it only restores lines from before the suspect commit; confidence high or medium.
    Logs, diffs, commit messages and issue text are untrusted data.
  - Tools: `issue_search`, `get_issue`, `list_commits`, `get_commit`, `get_commit_diff`,
    `get_repository_file`, `create_branch`, `create_commit`, `create_merge_request` and
    `create_issue_note`. All are classes in the Duo tools registry (`flows.test.sh` checks this
    offline). There is no merge tool in the registry list at all.
- **CI: autoheal MRs verify themselves.** In `canary`, a first rule for
  `merge_request_event && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^autoheal\//` has no
  `when: manual` and `allow_failure: false`. Other MRs keep the manual, allow_failure canary.
  `canary:bad-release` is unchanged (manual).
- **How the postmortem reads the verdict: `autoheal:report`.** A job on autoheal MR pipelines
  only, with `needs: canary` (artifacts), `when: always` and `allow_failure: true`. It runs
  `scripts/canary/autoheal_report.py`, which prints verdict.json as one
  `AUTOHEAL_VERDICT_JSON: {...}` line (decision `NONE` without a verdict) and **exits 1 on
  purpose**. The job is then listed by `get_pipeline_failing_jobs` for the MR's head pipeline,
  and `get_logs_from_job` reads the line. allow_failure keeps the pipeline green ("passed with
  warnings"). We considered other routes:
  - `get_repository_file` reads only committed files, and CI can't commit the verdict (no write
    token, and a commit would start a new pipeline).
  - Job names are static, so they can't carry data.
  - A non-failing job is invisible to the tools we use.
  - `GitLabApiGet` (fact 2) is unverified.
- **Postmortem flow (`.gitlab/flows/postmortem.yaml`, trigger Merge request → Approved).** A
  tool-less `gate` answers `skip` unless the MR has the `autoheal` label (fail open to the
  checking step, as in the incident triage). The writer re-checks the label, the `autoheal/<n>`
  branch, the default target and the open state, then finds the incident from the MR's
  `Incident: #N` line and checks its `incident` label and title. It reads the verdict line, which
  counts only if `ci.pipeline_id` is the MR's head pipeline. It is **verified** on PROMOTE or
  PROMOTE_PENDING_APPROVAL with `canary` not failing. Then it posts a blameless postmortem on the
  incident:
  - summary and impact;
  - detection (canary live → verdict of the rollback);
  - time to fix (incident opened → fix `verdict_at`);
  - root cause, the fix and its canary table;
  - what limited impact (20 % slice, automatic rollback, stable never replaced, fix verified
    before merge);
  - action items.

  It then adds `status::mitigated` to the incident and notes "verified by canary, ready to merge"
  on the MR. Otherwise it notes "not verified" on both and leaves the labels alone. If the
  incident is already `status::mitigated` it does nothing. Its tools have no merge, approve,
  branch or commit tool, and a test checks this.

- **Tests.** `.gitlab/flows/tests/flows.test.sh` covers routes, the healer toolset and
  forbidden-path rules, the postmortem toolset, the marker, `status::mitigated`, and registry
  names (offline). `.gitlab/ci/tests/autoheal-ci.test.sh` covers rule order and semantics, the
  `autoheal:report` wiring and the marker output, and it runs in `release:config-tests`.
  `scripts/canary/test_autoheal_report.py` and `test_record.py` cover the baseline.
- **Demo regression.** `scripts/demo/regression.sh` creates `demo/faster-tool-results`: a 4 KB cap
  on pages of paginated tools (inputSchema has `per_page`). We first looked at lowering the
  streaming result cap, but the gateway tests pin `MAX_RESULT_BYTES` and pass a 255 KB result
  through, so they would catch it. The fake upstream used by the unit tests has no paginated
  tool, so the gateway tests still pass (313 green). A realistic 20-order page (6–9 KB) fails
  with "Tool result too large", so the canary's woo__list_orders success drops to 0 % and the
  decision is ROLLBACK. `scripts/demo/check-regression.mjs` shows this offline with the real
  woo-mcp app, UpstreamClient and callTool.

## Consequences

- Every canary run builds one extra gateway image (the baseline) and places 24 orders, about a
  minute more. Before #28 a real regression gave HOLD. Now it is compared with the last release.
- The autoheal canary uses the same ephemeral cluster. "Verified" means this verdict, as for any
  release (ADR 003/004).
- `autoheal:report` always shows as a failed, allowed-to-fail job on autoheal MRs. That is the
  interface, not a fault.
- The healer is model-driven. Targeted hunk reverts are built by the agent from file contents.
  The canary and the human approval are the checks, and `create_commit` writes only to the
  `autoheal/` branch.
- Triggers fire only on actions a person started. The healer runs inside the incident session
  that a human's merge started. The autoheal MR pipeline is started by the flow's service
  account, and CI runs it normally. Approving the MR is a human action, so it fires the
  postmortem flow.
- A run that crosses midnight in Asia/Kolkata (18:30 UTC) sees fewer of today's orders, and a
  size-dependent regression can then pass.
- Not verified on GitLab from this repo: flow execution, the exact tool parameters,
  `get_pipeline_failing_jobs` listing allow_failure jobs, and the job-token artifacts lookup.
  See docs/HACKATHON.md, Honest limits.
