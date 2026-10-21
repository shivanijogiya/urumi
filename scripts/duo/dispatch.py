#!/usr/bin/env python3
"""Start the Duo flows from CI (#27, H4; docs/adr/007-duo-dispatch.md). Python 3 stdlib only.

GitLab creates one trigger per custom flow, and the only event types are Mention, Assign and Assign
reviewer of the flow's service account. A flow then gets `context:goal` = the iid of the MR or issue
(live session 9814505: goal "31"). So CI starts a flow by assigning its service account:

  dispatch.py risk-gate <mr_iid>
      Adds the risk-gate account to the MR's reviewers (existing reviewers kept; nothing to do when
      it is already one). Job duo:risk-gate, every MR pipeline.
  dispatch.py incident --record verdict.json
      After a canary ROLLBACK: opens the incident issue "Incident: canary rolled back <short sha>
      (pipeline <id>)" with the canary record as a fenced JSON block after the line
      `CANARY_VERDICT_JSON:`, then assigns the incident account. If an open issue for the same
      pipeline exists, it only assigns that one. No record or not a ROLLBACK: nothing to do.
      Job duo:incident, default branch.

Env: DUO_DISPATCH_TOKEN (project access token, api scope, Developer; sent as PRIVATE-TOKEN and never
printed), CI_API_V4_URL, CI_PROJECT_ID, optional CI_PROJECT_URL and CI_PIPELINE_ID. Without the
token it prints one line and exits 0. Every HTTP call has a 15 s timeout. Exit 0 = done or nothing
to do, 1 = API or config error, 2 = bad arguments.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

RISK_GATE_USER_ID = 43587203  # ai-release-risk-gate-gitlab-ai-hackathon
INCIDENT_USER_ID = 43587207  # ai-canary-incident-gitlab-ai-hackathon
TIMEOUT_S = 15
MARKER = "CANARY_VERDICT_JSON:"
TITLE_PREFIX = "Incident: canary rolled back"
INCIDENT_LABELS = "incident,priority::high,status::ready"
SKIP_NO_TOKEN = "DUO_DISPATCH_TOKEN not set; skipping Duo dispatch"
_IID = re.compile(r"^[1-9][0-9]{0,18}$")


class DispatchError(Exception):
    """An error safe to print: never contains the token or request headers."""


def positive_int(value: object, what: str) -> int:
    s = str(value).strip() if value is not None else ""
    if not _IID.match(s):
        raise DispatchError(f"{what} must be a positive integer, got {s[:40]!r}")
    return int(s)


class Api:
    def __init__(self, base: str, project_id: int, token: str):
        if not base.startswith("https://"):
            raise DispatchError("CI_API_V4_URL must be an https:// URL")
        self.base = base.rstrip("/")
        self.project = f"/projects/{project_id}"
        self._token = token

    def __repr__(self) -> str:  # keep the token out of any accidental print
        return f"Api({self.base!r}, {self.project!r})"

    def call(self, method: str, path: str, body: dict | None = None, query: dict | None = None):
        path = self.project + path
        if query:
            path += "?" + urllib.parse.urlencode(query)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("PRIVATE-TOKEN", self._token)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise DispatchError(f"{method} {path}: HTTP {e.code}{_gitlab_message(e)}") from None
        except urllib.error.URLError as e:
            raise DispatchError(f"{method} {path}: {_reason(e.reason)}") from None
        except (TimeoutError, OSError) as e:
            raise DispatchError(f"{method} {path}: {_reason(e)}") from None
        try:
            return json.loads(raw or b"null")
        except ValueError:
            raise DispatchError(f"{method} {path}: response is not JSON") from None


def _reason(e: object) -> str:
    if isinstance(e, TimeoutError) or "timed out" in str(e):
        return f"timed out after {TIMEOUT_S} s"
    return str(e)[:120] or type(e).__name__


def _gitlab_message(e: urllib.error.HTTPError) -> str:
    """GitLab's {"message": ...} or {"error": ...} from the error body, shortened."""
    try:
        body = json.loads(e.read() or b"{}")
    except (ValueError, OSError):
        return ""
    msg = body.get("message") or body.get("error") if isinstance(body, dict) else None
    return f" ({json.dumps(msg)[:200]})" if msg else ""


def ids(users: object) -> list[int]:
    return [u["id"] for u in users or [] if isinstance(u, dict) and isinstance(u.get("id"), int)]


# --- risk-gate -------------------------------------------------------------------------------


def risk_gate(api: Api, mr_iid: int) -> str:
    mr = api.call("GET", f"/merge_requests/{mr_iid}")
    reviewers = ids(mr.get("reviewers") if isinstance(mr, dict) else None)
    if RISK_GATE_USER_ID in reviewers:
        return f"risk gate: user {RISK_GATE_USER_ID} is already a reviewer of !{mr_iid}; nothing to do"
    api.call("PUT", f"/merge_requests/{mr_iid}", {"reviewer_ids": reviewers + [RISK_GATE_USER_ID]})
    return f"risk gate: requested review from user {RISK_GATE_USER_ID} on !{mr_iid}"


# --- incident ----------------------------------------------------------------------------------


def load_record(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _pct(x: object) -> str:
    return f"{x * 100:.1f}%" if isinstance(x, (int, float)) and not isinstance(x, bool) else "n/a"


def _num(x: object) -> str:
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return "n/a"
    return f"{x:g}" if isinstance(x, float) else str(x)


def _text(x: object, limit: int = 200) -> str:
    """A record string for Markdown: one line, no backticks, no table pipes."""
    return re.sub(r"[`|\r\n]+", " ", str(x))[:limit] if x is not None else "n/a"


def _obj(record: dict, key: str) -> dict:
    return record[key] if isinstance(record.get(key), dict) else {}


def incident_title(record: dict, pipeline_id: int) -> str:
    sha = _text(_obj(record, "ci").get("commit_sha") or "unknown", 40)[:8]
    return f"{TITLE_PREFIX} {sha} (pipeline {pipeline_id})"


def incident_description(record: dict, pipeline_id: int, project_url: str) -> str:
    ci, tl, base = _obj(record, "ci"), _obj(record, "timeline"), _obj(record, "baseline")
    st, ca = _obj(record, "stable"), _obj(record, "canary")
    sha = _text(ci.get("commit_sha") or "unknown", 40)
    lines = []
    if record.get("force_bad") is True:
        lines += [
            "**Drill:** forced bad release (CANARY_FORCE_BAD=1 or canary:bad-release). Faults were "
            "injected on purpose; no code regression is implied.",
            "",
        ]
    lines += [
        f"The gateway canary of `{sha[:8]}` on `{_text(ci.get('ref'))}` was rolled back "
        f"(verdict {_text(record.get('verdict'))}, decision {_text(record.get('decision'))}, "
        f"risk {_text(record.get('risk'))}). {_num(record.get('canary_weight_pct'))}% of /api and "
        f"/mcp requests on the app host went to the canary from {_text(tl.get('canary_live_at'))} "
        f"to {_text(tl.get('applied_at'))}; the stable gateway was not changed. This issue is "
        "assigned to the Duo incident flow, which investigates and comments here.",
        "",
        "| Metric | Stable | Canary |",
        "| --- | --- | --- |",
        f"| requests | {_num(st.get('n'))} | {_num(ca.get('n'))} |",
        f"| errors | {_num(st.get('errors'))} | {_num(ca.get('errors'))} |",
        f"| error rate | {_pct(st.get('error_rate'))} | {_pct(ca.get('error_rate'))} |",
        f"| tool success rate | {_pct(st.get('success_rate'))} | {_pct(ca.get('success_rate'))} |",
        f"| p50 ms | {_num(st.get('p50_ms'))} | {_num(ca.get('p50_ms'))} |",
        f"| p95 ms | {_num(st.get('p95_ms'))} | {_num(ca.get('p95_ms'))} |",
        "",
        "**Reasons**",
        "",
    ]
    reasons = record.get("reasons") if isinstance(record.get("reasons"), list) else []
    lines += [f"- {_text(r)}" for r in reasons] or ["- none recorded"]
    lines += ["", "**Links**", ""]
    if ci.get("pipeline_url"):
        lines.append(f"- Pipeline: {_text(ci['pipeline_url'])}")
    if ci.get("job_url"):
        lines.append(f"- Canary job ({_text(ci.get('job_name'))}): {_text(ci['job_url'])}")
    if project_url and re.fullmatch(r"[0-9a-f]{7,40}", sha):
        lines.append(f"- Commit: {project_url.rstrip('/')}/-/commit/{sha}")
    lines.append(
        f"- Stable baseline: `{_text(base.get('stable_sha'), 40)}` ({_text(base.get('source'))})"
    )
    # Backticks are escaped so no record string can close the fence.
    record_json = json.dumps(record, indent=2, sort_keys=True).replace("`", "\\u0060")
    lines += [
        "",
        f"Pipeline ID: {pipeline_id}",
        "",
        MARKER,
        "```json",
        record_json,
        "```",
    ]
    return "\n".join(lines) + "\n"


def find_open_incident(api: Api, pipeline_id: int) -> dict | None:
    issues = api.call(
        "GET",
        "/issues",
        query={"state": "opened", "labels": "incident", "per_page": 100},
    )
    suffix = f"(pipeline {pipeline_id})"
    for issue in issues if isinstance(issues, list) else []:
        title = issue.get("title") if isinstance(issue, dict) else None
        if isinstance(title, str) and title.startswith(TITLE_PREFIX) and title.endswith(suffix):
            return issue
    return None


def assign(api: Api, issue: dict) -> str:
    iid = positive_int(issue.get("iid"), "issue iid")
    assignees = ids(issue.get("assignees"))
    if INCIDENT_USER_ID in assignees:
        return f"incident #{iid}: user {INCIDENT_USER_ID} is already assigned; nothing to do"
    # Separate update, not assignee_ids on create: the flow trigger is the Assign event.
    api.call("PUT", f"/issues/{iid}", {"assignee_ids": [INCIDENT_USER_ID] + assignees})
    return f"incident #{iid}: assigned user {INCIDENT_USER_ID}"


def incident(api: Api, record_path: str, env: dict) -> str:
    record = load_record(record_path)
    if record is None:
        return f"no readable canary record at {record_path} (no verdict); no incident"
    decision = record.get("decision")
    if decision != "ROLLBACK":
        return f"canary decision is {_text(decision, 40)}, not ROLLBACK; no incident"
    pipeline_id = positive_int(_obj(record, "ci").get("pipeline_id") or env.get("CI_PIPELINE_ID"), "pipeline id")
    existing = find_open_incident(api, pipeline_id)
    if existing is not None:
        return "existing " + assign(api, existing)
    created = api.call(
        "POST",
        "/issues",
        {
            "title": incident_title(record, pipeline_id),
            "description": incident_description(record, pipeline_id, env.get("CI_PROJECT_URL", "")),
            "labels": INCIDENT_LABELS,
        },
    )
    if not isinstance(created, dict):
        raise DispatchError("POST /issues: unexpected response")
    return "created " + assign(api, created)


# --- main --------------------------------------------------------------------------------------


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    env = env if env is not None else dict(os.environ)
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    rg = sub.add_parser("risk-gate", help="request a review from the risk-gate flow account")
    rg.add_argument("mr_iid")
    inc = sub.add_parser("incident", help="open/assign the incident issue after a ROLLBACK")
    inc.add_argument("--record", required=True, help="the canary job's verdict.json")
    a = p.parse_args(argv)

    token = env.get("DUO_DISPATCH_TOKEN", "")
    if not token.strip():
        print(SKIP_NO_TOKEN)
        return 0
    try:
        if a.cmd == "risk-gate":
            mr_iid = positive_int(a.mr_iid, "merge request iid")
        project_id = positive_int(env.get("CI_PROJECT_ID"), "CI_PROJECT_ID")
        api = Api(env.get("CI_API_V4_URL", ""), project_id, token)
        msg = risk_gate(api, mr_iid) if a.cmd == "risk-gate" else incident(api, a.record, env)
    except DispatchError as e:
        print(f"duo dispatch {a.cmd} failed: {e}", file=sys.stderr)
        return 1
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
