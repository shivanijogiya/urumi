---
name: fix-pipeline
description: Fix a failed GitLab CI job given its job id.
disable-model-invocation: true
argument-hint: "[job-id]"
allowed-tools: Bash(glab ci *) Bash(npm *) Bash(npx *) Bash(helm *) Bash(git add *) Bash(git commit *) Bash(git diff *) Bash(git status *)
---

## Failed job log (last 200 lines)
!`glab ci trace $0 2>&1 | tail -200 || true`

## Task
1. Find the root cause from the log above. Say it in one sentence.
2. Reproduce it locally with the same command the job runs (see `.gitlab-ci.yml`).
3. Fix the cause, not the symptom.
4. Re-run the failing command locally until it passes.
5. Commit with message `fix(ci): <cause>`.

Never weaken, skip, or delete a test or a security scan to make the job pass. If the failure is a real security finding, fix the code. If the cause is outside this repo (runner, network, quota), stop and report that instead of changing code.

Report: cause, fix, command run, its result.
