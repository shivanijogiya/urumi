# Self-healing demo (#28)

The whole loop, end to end: a bad merge, canary ROLLBACK, an incident, an autoheal MR, an automatic
canary PROMOTE, a human approval, the postmortem, and the merge. Design: [ADR 005](../../docs/adr/005-self-healing.md).
Flows must be registered first (docs/HACKATHON.md, "Register the flows"), including **Autoheal
postmortem** with trigger **Merge request → Approved**.

## 0. Check the regression offline (optional, 2 min)

```bash
node scripts/demo/check-regression.mjs        # PASS: 20 of 24 orders, ~9 KB through callTool
bash scripts/demo/regression.sh --verify      # builds the demo branch, runs the gateway unit
                                              # tests there (pass) and the check (FAIL)
```

`regression.sh` (without `--verify`) creates branch `demo/faster-tool-results` in the worktree
`.hermes/demo-faster-tool-results`. The branch holds one commit, "perf(gateway): cap paginated
tool results at 4 KB so pages stay fast". It never pushes, and it prints the push and MR commands.

## 1. The bad merge (a person)

```bash
bash scripts/demo/regression.sh
git -C .hermes/demo-faster-tool-results push -u origin demo/faster-tool-results
cd .hermes/demo-faster-tool-results && glab mr create --source-branch demo/faster-tool-results \
  --target-branch main --title "perf(gateway): cap paginated tool results at 4 KB so pages stay fast" \
  --description "Smaller pages come back faster. Unit tests pass." --yes
```

The MR pipeline is green: `test` passes, and the change is in `apps/gateway/src/core/`, which is
low risk. Its canary is manual, so leave it. **Merge** the MR. The merge is the human action
that fires the triggers.

## 2. Canary ROLLBACK → incident (automatic, ~15 min)

- main's `canary` builds stable from the last promoted commit and the canary from the merge. It
  seeds 24 orders for today and probes `woo__list_orders`.
- Log: `stable gateway = <old> (last-promoted), canary = <new>`, then
  `CANARY VERDICT: ROLLBACK`, reason `canary woo__list_orders success 0.0% vs minimum 95.0%`,
  then `RELEASE REJECTED: canary rolled back`. The pipeline **fails**.
- The **Canary incident** session opens `Incident: canary rolled back on main (<sha>)` and
  `Regression: gateway canary rejected at <sha> on main`. It answers `healable`.

## 3. Healer → autoheal MR (automatic, same session)

- `healer` lists the commits since the previous main tip and picks the one gateway commit. It
  matches the hunk `if (resultBytes > maxBytes)` with `MAX_PAGE_RESULT_BYTES = 4 * 1024` against
  "success 0 % with 2xx answers", and reverts those hunks in `limits.ts` and `call-tool.ts`.
- It opens MR **`Autoheal: 4 KB page cap rejects normal list_orders pages (incident #N)`** from
  `autoheal/<pipeline id>`, labelled `autoheal`. The MR has the root-cause analysis, the verdict
  table, the hunk and the confidence. The incident and the regression issue each get a note
  linking the MR.
- If it is not sure, or the suspect touched CI, charts or secrets, there is no MR. Instead both
  issues get a note "Autoheal: needs human." with its analysis.

## 4. Automatic canary on the autoheal MR (~15 min, no click)

- The MR pipeline runs `canary` automatically (autoheal rule): stable is the last promoted
  commit, the canary is the fix, and the result is **PROMOTE**.
- `autoheal:report` then shows as failed (allowed to fail; it fails on purpose). Its log has
  `AUTOHEAL_VERDICT_JSON: {"decision":"PROMOTE",...}`. The pipeline passes with warnings.

## 5. Approve (a person) → postmortem (automatic)

- **Approve** the autoheal MR. The **Autoheal postmortem** session reads the verdict line for the
  MR's head pipeline. On PROMOTE it:
  - posts `## Postmortem (autoheal)` on the incident (impact, detection minutes, time to fix,
    root cause, fix, what limited impact, action items);
  - adds the label `status::mitigated`;
  - notes on the MR: "Verified by canary (PROMOTE, pipeline N), ready to merge ...".
- If the canary did not PROMOTE, it notes "fix not verified" on the MR and the incident instead.

## 6. Merge (a person)

**Merge** the autoheal MR. main's canary promotes the fix. Close the regression issue (an action
item of the postmortem).

## Reset

```bash
git -C . worktree remove --force .hermes/demo-faster-tool-results
git branch -D demo/faster-tool-results
```
