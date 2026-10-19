#!/usr/bin/env bash
# One-time GitLab project setup. Run from the repo root, logged in with glab as YOU
# (Maintainer/Owner), after the project exists and the code is pushed.
#   - creates the workflow labels
#   - protects main: only Maintainers push/merge (Hermes, as Developer, cannot merge)
#   - merge only when the pipeline succeeds
set -euo pipefail

label() { # name color description
  glab label create --name "$1" --color "$2" --description "$3" >/dev/null 2>&1 \
    && echo "label + $1" || echo "label = $1 (exists)"
}

echo "== Labels"
label "status::ready"             "#428BCA" "Ready to start"
label "status::in-progress"       "#F0AD4E" "Hermes is working on it"
label "status::review"            "#5843AD" "MR open, pipeline/review running"
label "status::awaiting-approval" "#D9534F" "Waiting for Aadi to merge"
label "status::blocked"           "#333333" "Needs help"
label "status::needs-decision"    "#AD4363" "Waiting for a decision from Aadi"
label "app::woo-mcp"    "#69D100" "apps/woo-mcp"
label "app::gateway"    "#69D100" "apps/gateway"
label "app::dashboard"  "#69D100" "apps/dashboard"
label "app::contracts"  "#69D100" "packages/contracts"
label "app::infra"      "#69D100" "charts, scripts, cluster"
label "app::release"    "#69D100" "CI/CD, canary, Duo flows"
label "app::docs"       "#69D100" "docs"
label "priority::high"  "#FF0000" "Jumps the queue"
label "gate::contracts" "#8E44AD" "G1: Aadi approves contracts"
label "gate::infra"     "#8E44AD" "G3: Aadi approves infra/secrets changes"
label "checkpoint"      "#A8D695" "Milestone check"
label "optional"        "#CCCCCC" "Only after the checkpoint"
label "incident"        "#FF0000" "Opened by the Incident flow"

echo "== Protect main (Maintainers only push + merge)"
glab api --method DELETE "projects/:id/protected_branches/main" >/dev/null 2>&1 || true
glab api --method POST "projects/:id/protected_branches" \
  -f name=main -f push_access_level=40 -f merge_access_level=40 -f allow_force_push=false >/dev/null
echo "main protected"

echo "== Merge settings"
glab api --method PUT "projects/:id" \
  -f only_allow_merge_if_pipeline_succeeds=true \
  -f remove_source_branch_after_merge=true >/dev/null
echo "merge only when pipeline succeeds"

echo "== Done. Next: ./scripts/create-issues.sh"
