#!/usr/bin/env python3
"""The `autoheal:report` CI job (#28, #32; docs/adr/005-self-healing.md). Python 3 stdlib only.

The postmortem flow (.gitlab/flows/postmortem.yaml) must read the canary verdict of an autoheal
merge request's pipeline. Duo flows cannot read CI job logs in this project (#32: get_logs_from_job
failed on the job autoheal:report, session 9840424), but they can read the MR description
(get_merge_request). This job runs after `canary` on autoheal MR pipelines (allow_failure: true)
and:

  1. prints the canary's verdict.json, filtered to KEEP, as one log line
         AUTOHEAL_VERDICT_JSON: {...}
     (decision NONE when the canary left no verdict.json, a setup failure);
  2. writes the same line into the MR description, between
         <!-- autoheal-verdict:start -->  and  <!-- autoheal-verdict:end -->
     replacing an existing block (reruns are idempotent) or appending one;
  3. exits 1 on purpose, so get_pipeline_failing_jobs lists the job (the postmortem's proof that
     the pipeline reached the report) and allow_failure keeps the pipeline green.

The JSON cannot close the HTML comment or start a mention: "<", ">" and "@" are \\u-escaped. The
block is capped at MAX_BLOCK_CHARS ("timeline" dropped first, then reasons beyond 5).

Env for step 2: DUO_DISPATCH_TOKEN (sent as PRIVATE-TOKEN, never printed), CI_API_V4_URL,
CI_PROJECT_ID, CI_MERGE_REQUEST_IID. Missing env or an API error: one line saying why, and the job
still exits 1 after printing the marker line. Every HTTP call has a 10 s timeout.

  scripts/canary/autoheal_report.py [--verdict verdict.json] [--no-mr-update]     always exits 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

MARKER = "AUTOHEAL_VERDICT_JSON: "
BLOCK_START = "<!-- autoheal-verdict:start -->"
BLOCK_END = "<!-- autoheal-verdict:end -->"
BLOCK_HEADING = "### Canary verdict (written by CI job autoheal:report — do not edit)"
MAX_BLOCK_CHARS = 4000
MAX_REASONS = 5
TIMEOUT_S = 10
NOT_UPDATED = "autoheal:report: MR description not updated: "
_ID = re.compile(r"^[1-9][0-9]{0,18}$")
# Fields the postmortem needs; everything else in verdict.json is dropped.
KEEP = (
    "verdict",
    "decision",
    "reasons",
    "stable",
    "canary",
    "samples",
    "risk",
    "force_bad",
    "canary_weight_pct",
    "baseline",
    "timeline",
    "ci",
)


class ReportError(Exception):
    """An error safe to print: never contains the token, request headers or a response body."""


def summary(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"decision": "NONE", "reason": "the canary job left no readable verdict.json"}
    if not isinstance(data, dict) or not isinstance(data.get("decision"), str):
        return {"decision": "NONE", "reason": "verdict.json has no decision"}
    return {k: data[k] for k in KEEP if k in data}


def compact(s: dict) -> str:
    """One-line JSON that cannot end the HTML comment, contain a marker or mention anyone."""
    text = json.dumps(s, separators=(",", ":"), sort_keys=True, ensure_ascii=True)
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("@", "\\u0040")


def _block(s: dict) -> str:
    return "\n".join([BLOCK_START, BLOCK_HEADING, MARKER + compact(s), BLOCK_END])


def capped(s: dict) -> dict:
    """s, or a smaller copy whose block fits MAX_BLOCK_CHARS."""
    if len(_block(s)) <= MAX_BLOCK_CHARS:
        return s
    s = {k: v for k, v in s.items() if k != "timeline"}
    if len(_block(s)) <= MAX_BLOCK_CHARS:
        return s
    if isinstance(s.get("reasons"), list):
        s["reasons"] = s["reasons"][:MAX_REASONS]
        if len(_block(s)) <= MAX_BLOCK_CHARS:
            return s
    ci = s.get("ci") if isinstance(s.get("ci"), dict) else {}
    return {
        "decision": str(s.get("decision"))[:40],
        "ci": {"pipeline_id": str(ci.get("pipeline_id"))[:40]},
        "truncated": True,
    }


def verdict_block(s: dict) -> str:
    return _block(capped(s))


def with_block(description: str | None, block: str) -> str:
    """The description with exactly one verdict block: in place of the first existing one (any
    others, and an unterminated start marker with everything after it, are removed), or appended
    after a blank line."""
    desc = description or ""
    first = desc.find(BLOCK_START)
    if first == -1:
        return desc.rstrip("\n") + "\n\n" + block if desc.strip() else block
    parts, rest = [desc[:first]], desc[first:]
    while True:
        i = rest.find(BLOCK_START)
        if i == -1:
            parts.append(rest)
            break
        parts.append(rest[:i])
        j = rest.find(BLOCK_END, i)
        rest = "" if j == -1 else rest[j + len(BLOCK_END) :]
    # parts[1] is the empty text before the first block: put the new block there.
    return parts[0] + block + "".join(parts[2:])


class Api:
    def __init__(self, base: str, project_id: int, token: str):
        if not base.startswith("https://"):
            raise ReportError("CI_API_V4_URL must be an https:// URL")
        self.base = base.rstrip("/")
        self.project = f"/projects/{project_id}"
        self._token = token

    def __repr__(self) -> str:  # keep the token out of any accidental print
        return f"Api({self.base!r}, {self.project!r})"

    def call(self, method: str, path: str, body: dict | None = None):
        path = self.project + path
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_unredirected_header("PRIVATE-TOKEN", self._token)  # never sent on to a redirect
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise ReportError(f"{method} {path}: HTTP {e.code}{_gitlab_message(e)}") from None
        except urllib.error.URLError as e:
            raise ReportError(f"{method} {path}: {_reason(e.reason)}") from None
        except (TimeoutError, OSError) as e:
            raise ReportError(f"{method} {path}: {_reason(e)}") from None
        try:
            return json.loads(raw or b"null")
        except ValueError:
            raise ReportError(f"{method} {path}: response is not JSON") from None


def _reason(e: object) -> str:
    if isinstance(e, TimeoutError) or "timed out" in str(e):
        return f"timed out after {TIMEOUT_S} s"
    return str(e)[:120] or type(e).__name__


def _gitlab_message(e: urllib.error.HTTPError) -> str:
    """GitLab's {"message": ...} from the error body, shortened; nothing else of the body."""
    try:
        body = json.loads(e.read() or b"{}")
    except (ValueError, OSError):
        return ""
    msg = body.get("message") if isinstance(body, dict) else None
    return f" ({json.dumps(msg)[:200]})" if msg else ""


def _positive_int(value: object, what: str) -> int:
    s = str(value).strip() if value is not None else ""
    if not _ID.match(s):
        raise ReportError(f"{what} must be a positive integer")
    return int(s)


def update_mr(block: str, env: dict) -> str:
    token = env.get("DUO_DISPATCH_TOKEN", "")
    if not token.strip():
        raise ReportError("DUO_DISPATCH_TOKEN not set")
    if not env.get("CI_API_V4_URL"):
        raise ReportError("CI_API_V4_URL not set")
    project_id = _positive_int(env.get("CI_PROJECT_ID"), "CI_PROJECT_ID")
    mr_iid = _positive_int(env.get("CI_MERGE_REQUEST_IID"), "CI_MERGE_REQUEST_IID")
    api = Api(env["CI_API_V4_URL"], project_id, token)
    mr = api.call("GET", f"/merge_requests/{mr_iid}")
    if not isinstance(mr, dict):
        raise ReportError(f"GET {api.project}/merge_requests/{mr_iid}: unexpected response")
    current = mr.get("description") if isinstance(mr.get("description"), str) else ""
    api.call("PUT", f"/merge_requests/{mr_iid}", {"description": with_block(current, block)})
    return f"autoheal:report: verdict written to the description of !{mr_iid}"


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    env = env if env is not None else dict(os.environ)
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--verdict", default="verdict.json")
    p.add_argument("--no-mr-update", action="store_true", help="only print (local use)")
    a = p.parse_args(argv)
    s = capped(summary(a.verdict))
    print(f"autoheal canary decision: {s['decision']}")
    print(MARKER + compact(s))
    if a.no_mr_update:
        print(NOT_UPDATED + "--no-mr-update")
    else:
        try:
            print(update_mr(_block(s), env))
        except ReportError as e:
            print(NOT_UPDATED + str(e))
        except Exception as e:  # noqa: BLE001 - the report must never crash the job
            print(NOT_UPDATED + f"unexpected error ({type(e).__name__})")
    print(
        "autoheal:report fails on purpose (allow_failure): get_pipeline_failing_jobs lists it, "
        "which shows the postmortem flow that this pipeline reached the report. The canary job's "
        "own status is the verification.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
