---
name: mr-evidence
description: Collect evidence for a merge request — diff stats, test and e2e results — into the MR template.
disable-model-invocation: true
argument-hint: "[issue-number] [D-steps]"
allowed-tools: Bash(npm *) Bash(./tests/*) Bash(git diff *) Bash(git log *)
---

## Commits on this branch
!`git log origin/main..HEAD --oneline || true`

## Diff size
!`git diff origin/main --stat | tail -5 || true`

## Task
Issue: #$0. E2E steps: $1

1. Run `npm test --workspaces --if-present` and capture the summary lines.
2. If E2E steps were given, run `./tests/e2e/run.sh $1` and capture the PASS/FAIL lines.
3. Write `.hermes/mr.md` with exactly this structure, filled with real output (no paraphrased results):

```
## What
## Why
Closes #$0 — requirement IDs: …
## How
## Evidence
- Tests: <command> → <summary line>
- E2E: <steps> → <PASS/FAIL lines>
- Diff: <files changed, insertions, deletions>
## Risk
## Gate
G2 merge  (+ G3 if charts/values, RBAC, NetworkPolicy, Secrets or Ingress changed)
```

If anything failed, say so at the top of the file. Do not hide failures.
