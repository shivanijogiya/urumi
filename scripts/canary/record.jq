# verdict.py's report + what scripts/canary/ci.sh did with it (#24). Every input is a string --arg;
# empty CI fields become null (outside GitLab CI). Output: the verdict.json artifact, also printed
# as the `CANARY_VERDICT_JSON:` log line that .gitlab/flows/incident.yaml reads.
def v: if . == "" then null else . end;
. + {
  decision: $decision,
  action: $action,
  tag: $tag,
  force_bad: ($force_bad == "1"),
  risk: ($risk | v),
  canary_weight_pct: ($weight | tonumber),
  traffic: "/api and /mcp on the app host",
  timeline: {canary_live_at: $live, verdict_at: $verdict_at, applied_at: $applied},
  ci: {
    pipeline_id: ($pipeline_id | v),
    pipeline_url: ($pipeline_url | v),
    job_name: ($job_name | v),
    job_url: ($job_url | v),
    commit_sha: $sha,
    ref: ($ref | v)
  }
}
