#!/usr/bin/env bash
# Creates one GitLab issue per backlog entry in docs/backlog.json, in order,
# writing real issue numbers into each "Depends on" line.
# Re-running is safe: entries already created (tracked in docs/.issue-map.json) are skipped.
set -euo pipefail

BACKLOG=${1:-docs/backlog.json}
MAP=docs/.issue-map.json
[ -f "$MAP" ] || echo '{}' > "$MAP"

count=$(jq length "$BACKLOG")
for i in $(seq 0 $((count - 1))); do
  e=$(jq ".[$i]" "$BACKLOG")
  key=$(jq -r .key <<<"$e")
  if jq -e --arg k "$key" 'has($k)' "$MAP" >/dev/null; then
    echo "skip $key (#$(jq -r --arg k "$key" '.[$k]' "$MAP"))"; continue
  fi

  title=$(jq -r .title <<<"$e")
  app=$(jq -r .app <<<"$e")
  est=$(jq -r .est_h <<<"$e")
  reqs=$(jq -r '.req | join(", ")' <<<"$e")
  missing=$(jq -r --slurpfile m "$MAP" '[.deps[] | select($m[0][.] == null)] | join(" ")' <<<"$e")
  if [ -n "$missing" ]; then echo "$key depends on $missing, which is not created yet. Fix the order in $BACKLOG."; exit 1; fi
  deps=$(jq -r --slurpfile m "$MAP" '[.deps[] | "#" + ($m[0][.] | tostring)] | join(", ")' <<<"$e")
  [ -z "$deps" ] && deps="none"
  acc=$(jq -r '.acceptance | map("- [ ] " + .) | join("\n")' <<<"$e")
  labels=$(jq -r --arg app "app::$app" '([ "status::ready", $app ] + .labels) | join(",")' <<<"$e")

  desc=$(printf '**Backlog key:** %s\n**Requirements:** %s\n**Estimate:** %sh\n**Depends on:** %s\n\n## Acceptance criteria\n%s\n' \
    "$key" "$reqs" "$est" "$deps" "$acc")

  url=$(glab issue create --title "$title" --description "$desc" --label "$labels" --yes 2>&1 | grep -Eo 'https://[^ ]+/-/(issues|work_items)/[0-9]+' | tail -1)
  iid=${url##*/}
  if [ -z "$iid" ]; then echo "failed to create $key"; exit 1; fi
  tmp=$(mktemp); jq --arg k "$key" --argjson v "$iid" '. + {($k): $v}' "$MAP" > "$tmp" && mv "$tmp" "$MAP"
  echo "created $key -> #$iid"
done
echo "Done. Map saved in $MAP"
