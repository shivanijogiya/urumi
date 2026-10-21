"""Unit tests for dispatch.py (#27): the CI jobs that start the Duo flows by assigning their service
accounts. No network: urllib.request.urlopen is replaced by a fake GitLab API that records every
request.
  python3 -m unittest discover -s scripts/duo -p 'test_*.py'
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dispatch  # noqa: E402

TOKEN = "glpat-SENTINEL-do-not-print"
ENV = {
    "DUO_DISPATCH_TOKEN": TOKEN,
    "CI_API_V4_URL": "https://gitlab.example/api/v4",
    "CI_PROJECT_ID": "87777765",
    "CI_PROJECT_URL": "https://gitlab.example/g/showcase",
}
API = "https://gitlab.example/api/v4/projects/87777765"

RECORD = {
    "verdict": "ROLLBACK",
    "decision": "ROLLBACK",
    "reasons": ["canary error rate 50.0% vs stable 0.0%", "x`y|z"],
    "stable": {"n": 120, "errors": 0, "error_rate": 0.0, "success_rate": 1.0, "p50_ms": 40, "p95_ms": 90.5},
    "canary": {"n": 30, "errors": 15, "error_rate": 0.5, "success_rate": 0.5, "p50_ms": 42, "p95_ms": 95},
    "force_bad": False,
    "risk": "low",
    "canary_weight_pct": 20,
    "baseline": {"stable_sha": "0123abcd0123abcd", "source": "last-promoted"},
    "timeline": {
        "canary_live_at": "2026-10-21T10:00:00Z",
        "verdict_at": "2026-10-21T10:01:30Z",
        "applied_at": "2026-10-21T10:02:00Z",
    },
    "ci": {
        "pipeline_id": "4242",
        "pipeline_url": "https://gitlab.example/g/showcase/-/pipelines/4242",
        "job_name": "canary",
        "job_url": "https://gitlab.example/g/showcase/-/jobs/99",
        "commit_sha": "abc1234def5678901234567890abcdef12345678",
        "ref": "main",
    },
}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class FakeGitLab:
    """Routes (method, url) to canned JSON replies and records each request."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.requests: list[dict] = []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data) if req.data else None
        self.requests.append(
            {"method": req.get_method(), "url": req.full_url, "body": body, "timeout": timeout,
             "headers": {k.lower(): v for k, v in req.header_items()}}
        )
        key = (req.get_method(), req.full_url)
        if key not in self.routes:
            raise AssertionError(f"unexpected request {key}")
        reply = self.routes[key]
        if isinstance(reply, BaseException):
            raise reply
        return FakeResponse(json.dumps(reply).encode())


def run(argv: list[str], routes: dict | None = None, env: dict | None = None):
    fake = FakeGitLab(routes or {})
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(dispatch.urllib.request, "urlopen", fake), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = dispatch.main(argv, env=dict(ENV if env is None else env))
    return code, out.getvalue(), err.getvalue(), fake.requests


def http_error(url: str, code: int, body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(url, code, "err", {"PRIVATE-TOKEN": TOKEN}, io.BytesIO(json.dumps(body).encode()))


class TokenAndConfig(unittest.TestCase):
    def test_no_token_skips_with_one_line_and_exit_0(self):
        for cmd in (["risk-gate", "31"], ["incident", "--record", "missing.json"]):
            env = {k: v for k, v in ENV.items() if k != "DUO_DISPATCH_TOKEN"}
            code, out, err, reqs = run(cmd, env=env)
            self.assertEqual(code, 0)
            self.assertEqual(out, dispatch.SKIP_NO_TOKEN + "\n")
            self.assertEqual(out.strip(), "DUO_DISPATCH_TOKEN not set; skipping Duo dispatch")
            self.assertEqual(reqs, [])

    def test_blank_token_also_skips(self):
        code, out, _, reqs = run(["risk-gate", "31"], env={**ENV, "DUO_DISPATCH_TOKEN": "  "})
        self.assertEqual((code, out.strip(), reqs), (0, dispatch.SKIP_NO_TOKEN, []))

    def test_iid_must_be_a_positive_integer(self):
        for bad in ("0", "-3", "abc", "31; rm", "", "1e3", "007"):
            code, out, err, reqs = run(["risk-gate", bad])
            self.assertEqual(code, 1, bad)
            self.assertIn("merge request iid must be a positive integer", err)
            self.assertEqual(reqs, [])

    def test_project_id_and_https_api_url_are_required(self):
        code, _, err, _ = run(["risk-gate", "31"], env={**ENV, "CI_PROJECT_ID": ""})
        self.assertEqual(code, 1)
        self.assertIn("CI_PROJECT_ID must be a positive integer", err)
        code, _, err, _ = run(["risk-gate", "31"], env={**ENV, "CI_API_V4_URL": "http://gitlab.example/api/v4"})
        self.assertEqual(code, 1)
        self.assertIn("https://", err)

    def test_requests_send_token_header_and_15s_timeout(self):
        routes = {("GET", f"{API}/merge_requests/31"): {"iid": 31, "reviewers": []},
                  ("PUT", f"{API}/merge_requests/31"): {"iid": 31}}
        _, _, _, reqs = run(["risk-gate", "31"], routes)
        self.assertEqual(len(reqs), 2)
        for r in reqs:
            self.assertEqual(r["headers"]["private-token"], TOKEN)
            self.assertEqual(r["timeout"], 15)
            self.assertNotIn(TOKEN, r["url"])


class Errors(unittest.TestCase):
    """Errors are one clear line on stderr, exit 1, and never contain the token or headers."""

    def check_error(self, reply, expect: str):
        routes = {("GET", f"{API}/merge_requests/31"): reply}
        code, out, err, _ = run(["risk-gate", "31"], routes)
        self.assertEqual(code, 1)
        self.assertIn(expect, err)
        self.assertTrue(err.startswith("duo dispatch risk-gate failed: GET /projects/87777765/merge_requests/31"))
        for text in (out, err):
            self.assertNotIn(TOKEN, text)
            self.assertNotIn("PRIVATE-TOKEN", text)
        self.assertNotIn("Traceback", err)

    def test_http_error_shows_status_and_gitlab_message(self):
        self.check_error(http_error(f"{API}/merge_requests/31", 403, {"message": "403 Forbidden"}),
                         'HTTP 403 ("403 Forbidden")')

    def test_http_error_without_json_body(self):
        e = urllib.error.HTTPError(f"{API}/merge_requests/31", 502, "Bad Gateway", {}, io.BytesIO(b"<html>"))
        self.check_error(e, "HTTP 502")

    def test_timeout(self):
        self.check_error(urllib.error.URLError(socket.timeout("timed out")), "timed out after 15 s")
        self.check_error(TimeoutError("read timed out"), "timed out after 15 s")

    def test_connection_error(self):
        self.check_error(urllib.error.URLError(ConnectionRefusedError(61, "Connection refused")),
                         "Connection refused")


class RiskGate(unittest.TestCase):
    def test_adds_the_risk_gate_account_and_keeps_existing_reviewers(self):
        routes = {
            ("GET", f"{API}/merge_requests/31"): {"iid": 31, "reviewers": [{"id": 7}, {"id": 9}]},
            ("PUT", f"{API}/merge_requests/31"): {"iid": 31},
        }
        code, out, _, reqs = run(["risk-gate", "31"], routes)
        self.assertEqual(code, 0)
        self.assertEqual(reqs[1]["body"], {"reviewer_ids": [7, 9, 43587203]})
        self.assertEqual(reqs[1]["headers"]["content-type"], "application/json")
        self.assertIn("requested review from user 43587203 on !31", out)

    def test_already_a_reviewer_does_nothing(self):
        routes = {("GET", f"{API}/merge_requests/31"): {"iid": 31, "reviewers": [{"id": 43587203}]}}
        code, out, _, reqs = run(["risk-gate", "31"], routes)
        self.assertEqual(code, 0)
        self.assertEqual([r["method"] for r in reqs], ["GET"])
        self.assertIn("already a reviewer", out)


class Incident(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def record(self, data, name: str = "verdict.json") -> str:
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return path

    def routes(self, existing: list, created: dict | None = None) -> dict:
        r = {("GET", f"{API}/issues?state=opened&labels=incident&per_page=100"): existing}
        if created is not None:
            r[("POST", f"{API}/issues")] = created
            r[("PUT", f"{API}/issues/{created['iid']}")] = created
        return r

    def test_rollback_creates_the_issue_then_assigns_the_incident_account(self):
        code, out, _, reqs = run(["incident", "--record", self.record(RECORD)],
                                 self.routes([], {"iid": 12, "assignees": []}))
        self.assertEqual(code, 0, out)
        self.assertEqual([r["method"] for r in reqs], ["GET", "POST", "PUT"])
        post = reqs[1]["body"]
        self.assertEqual(post["title"], "Incident: canary rolled back abc1234d (pipeline 4242)")
        self.assertEqual(post["labels"], "incident,priority::high,status::ready")
        self.assertNotIn("assignee_ids", post)
        self.assertEqual(reqs[2]["body"], {"assignee_ids": [43587207]})
        self.assertIn("created incident #12: assigned user 43587207", out)

    def test_description_has_summary_table_reasons_links_and_the_record_block(self):
        _, _, _, reqs = run(["incident", "--record", self.record(RECORD)],
                            self.routes([], {"iid": 12, "assignees": []}))
        d = reqs[1]["body"]["description"]
        self.assertIn("was rolled back", d)
        self.assertIn("| Metric | Stable | Canary |", d)
        self.assertIn("| error rate | 0.0% | 50.0% |", d)
        self.assertIn("| tool success rate | 100.0% | 50.0% |", d)
        self.assertIn("| p95 ms | 90.5 | 95 |", d)
        self.assertIn("- canary error rate 50.0% vs stable 0.0%", d)
        self.assertIn("- x y z", d)  # backticks and pipes stripped from record text
        self.assertIn("- Pipeline: https://gitlab.example/g/showcase/-/pipelines/4242", d)
        self.assertIn("- Canary job (canary): https://gitlab.example/g/showcase/-/jobs/99", d)
        self.assertIn(f"- Commit: https://gitlab.example/g/showcase/-/commit/{RECORD['ci']['commit_sha']}", d)
        self.assertIn("Pipeline ID: 4242", d)
        self.assertNotIn("**Drill:**", d)
        # The flow parses the fenced block after the marker line.
        after = d.split("\nCANARY_VERDICT_JSON:\n", 1)[1]
        self.assertTrue(after.startswith("```json\n"))
        block = after[len("```json\n"):].split("\n```", 1)[0]
        self.assertEqual(json.loads(block), RECORD)
        self.assertEqual(d.count("```"), 2)

    def test_description_states_what_the_canary_job_did_without_its_log(self):
        # #32: the incident flow cannot read job logs; the issue is its evidence of the rollback.
        rec = {**RECORD, "action": "rolled-back",
               "samples": {"total": 150, "stable": 120, "canary": 30, "unknown": 0, "unattributed_errors": 0}}
        _, _, _, reqs = run(["incident", "--record", self.record(rec)],
                            self.routes([], {"iid": 12, "assignees": []}))
        d = reqs[1]["body"]["description"]
        self.assertIn(
            "**CI canary record** (job canary, https://gitlab.example/g/showcase/-/jobs/99, pipeline "
            "4242): verdict ROLLBACK, decision ROLLBACK, action rolled-back; samples 150 (stable 120, "
            "canary 30, unknown 0, unattributed errors 0).",
            d,
        )
        # Fields absent from an older record read n/a; no job URL still names the job.
        rec = {**RECORD, "ci": {**RECORD["ci"], "job_url": None}}
        _, _, _, reqs = run(["incident", "--record", self.record(rec)],
                            self.routes([], {"iid": 12, "assignees": []}))
        d = reqs[1]["body"]["description"]
        self.assertIn("**CI canary record** (job canary, no job URL, pipeline 4242): verdict ROLLBACK, "
                      "decision ROLLBACK, action n/a; samples n/a (stable n/a, canary n/a, unknown n/a, "
                      "unattributed errors n/a).", d)

    def test_drill_is_marked(self):
        _, _, _, reqs = run(["incident", "--record", self.record({**RECORD, "force_bad": True})],
                            self.routes([], {"iid": 12, "assignees": []}))
        self.assertTrue(reqs[1]["body"]["description"].startswith("**Drill:**"))

    def test_existing_open_incident_for_the_pipeline_is_only_assigned(self):
        existing = [
            {"iid": 3, "title": "Incident: canary rolled back abc1234d (pipeline 42421)", "assignees": []},
            {"iid": 5, "title": "Incident: canary rolled back abc1234d (pipeline 4242)",
             "assignees": [{"id": 11}]},
        ]
        routes = self.routes(existing)
        routes[("PUT", f"{API}/issues/5")] = {"iid": 5}
        code, out, _, reqs = run(["incident", "--record", self.record(RECORD)], routes)
        self.assertEqual(code, 0)
        self.assertEqual([r["method"] for r in reqs], ["GET", "PUT"])
        self.assertEqual(reqs[1]["body"], {"assignee_ids": [43587207, 11]})
        self.assertIn("existing incident #5", out)

    def test_existing_incident_already_assigned_does_nothing(self):
        existing = [{"iid": 5, "title": "Incident: canary rolled back abc1234d (pipeline 4242)",
                     "assignees": [{"id": 43587207}]}]
        code, out, _, reqs = run(["incident", "--record", self.record(RECORD)], self.routes(existing))
        self.assertEqual(code, 0)
        self.assertEqual([r["method"] for r in reqs], ["GET"])
        self.assertIn("already assigned", out)

    def test_no_record_or_not_rollback_creates_nothing(self):
        cases = [
            (os.path.join(self.dir.name, "missing.json"), "no readable canary record"),
            (self.record("not json", "bad.json"), "no readable canary record"),
            (self.record({**RECORD, "decision": "HOLD"}, "hold.json"), "canary decision is HOLD, not ROLLBACK"),
            (self.record({**RECORD, "decision": "PROMOTE"}, "promote.json"), "not ROLLBACK"),
        ]
        for path, expect in cases:
            code, out, err, reqs = run(["incident", "--record", path])
            self.assertEqual((code, reqs), (0, []), path)
            self.assertIn(expect, out)

    def test_pipeline_id_falls_back_to_ci_pipeline_id_and_is_validated(self):
        rec = {**RECORD, "ci": {**RECORD["ci"], "pipeline_id": None}}
        code, out, _, reqs = run(["incident", "--record", self.record(rec)],
                                 self.routes([], {"iid": 12, "assignees": []}),
                                 env={**ENV, "CI_PIPELINE_ID": "4242"})
        self.assertEqual(code, 0, out)
        self.assertTrue(reqs[1]["body"]["title"].endswith("(pipeline 4242)"))
        rec = {**RECORD, "ci": {**RECORD["ci"], "pipeline_id": "42; drop"}}
        code, _, err, reqs = run(["incident", "--record", self.record(rec)])
        self.assertEqual((code, reqs), (1, []))
        self.assertIn("pipeline id must be a positive integer", err)

    def test_api_error_on_create_is_reported_without_the_token(self):
        routes = self.routes([])
        routes[("POST", f"{API}/issues")] = http_error(f"{API}/issues", 401, {"message": "401 Unauthorized"})
        code, out, err, _ = run(["incident", "--record", self.record(RECORD)], routes)
        self.assertEqual(code, 1)
        self.assertIn("POST /projects/87777765/issues: HTTP 401", err)
        self.assertNotIn(TOKEN, out + err)


if __name__ == "__main__":
    unittest.main()
