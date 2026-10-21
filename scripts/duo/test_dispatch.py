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
        for cmd in (["risk-gate", "31"], ["incident", "--record", "missing.json"],
                    ["postmortem", "31", "--record", "missing.json"],
                    ["release-close", "--record", "missing.json"]):
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


class RecordFiles(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def record(self, data, name: str = "verdict.json") -> str:
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return path

    def gating_cases(self) -> list:
        """(record path, expected output) for every record that must change nothing."""
        return [
            (os.path.join(self.dir.name, "missing.json"), "no readable canary record"),
            (self.record("not json", "bad.json"), "no readable canary record"),
            (self.record({**PROMOTED, "decision": "ROLLBACK"}, "rb.json"), "canary decision is ROLLBACK"),
            (self.record({**PROMOTED, "decision": "HOLD"}, "hold.json"), "canary decision is HOLD"),
            (self.record({**PROMOTED, "decision": "NONE"}, "none.json"), "canary decision is NONE"),
            (self.record({k: v for k, v in PROMOTED.items() if k != "decision"}, "nod.json"),
             "canary decision is n/a"),
        ]


PM_ENV = {**ENV, "CI_PIPELINE_ID": "5151"}
PROMOTED = {**RECORD, "verdict": "PROMOTE", "decision": "PROMOTE", "reasons": [],
            "ci": {**RECORD["ci"], "pipeline_id": "5151", "ref": "refs/merge-requests/40/head"}}
AUTOHEAL_MR = {"iid": 40, "state": "opened", "labels": ["autoheal"], "source_branch": "autoheal/4242",
               "title": "Autoheal: revert the 4 KB page cap (incident #12)",
               "description": "Incident: #12\nRegression: #13\n\n..."}
MR_NOTES = f"{API}/merge_requests/40/notes?sort=desc&per_page=100"


class Postmortem(RecordFiles):
    """#33: after a verified canary, CI mentions the postmortem account once on the autoheal MR."""

    def routes(self, mr: dict | None = None, notes: list | None = None) -> dict:
        return {
            ("GET", f"{API}/merge_requests/40"): AUTOHEAL_MR if mr is None else mr,
            ("GET", MR_NOTES): [] if notes is None else notes,
            ("POST", f"{API}/merge_requests/40/notes"): {"id": 1},
        }

    def test_promote_posts_one_mention_note_with_the_pipeline_marker(self):
        for decision in ("PROMOTE", "PROMOTE_PENDING_APPROVAL"):
            rec = self.record({**PROMOTED, "decision": decision})
            code, out, err, reqs = run(["postmortem", "40", "--record", rec], self.routes(), env=PM_ENV)
            self.assertEqual(code, 0, err)
            self.assertEqual([(r["method"], r["url"]) for r in reqs], [
                ("GET", f"{API}/merge_requests/40"), ("GET", MR_NOTES),
                ("POST", f"{API}/merge_requests/40/notes")])
            self.assertEqual(reqs[2]["body"], {"body": (
                f"@ai-canary-postmortem-gitlab-ai-hackathon !40: the canary verified this fix ({decision}, "
                "pipeline 5151). Check the verdict block and write the postmortem on the incident.\n\n"
                "postmortem-dispatch: pipeline 5151")})
            self.assertNotIn("<!--", reqs[2]["body"]["body"])
            self.assertEqual(out.strip(), f"postmortem: mentioned the postmortem account on !40 ({decision}, pipeline 5151)")

    def test_not_promoted_or_no_record_does_nothing(self):
        for path, expect in self.gating_cases():
            code, out, err, reqs = run(["postmortem", "40", "--record", path], env=PM_ENV)
            self.assertEqual((code, reqs), (0, []), path)
            self.assertIn(expect, out)
            self.assertIn("nothing to do", out)

    def test_not_an_open_autoheal_mr_is_skipped(self):
        cases = [
            {**AUTOHEAL_MR, "state": "merged"},
            {**AUTOHEAL_MR, "state": "closed"},
            {**AUTOHEAL_MR, "labels": ["bug"]},
            {**AUTOHEAL_MR, "labels": []},
            {**AUTOHEAL_MR, "source_branch": "feature/autoheal/4242"},
            {**AUTOHEAL_MR, "source_branch": "autoheal/4242-x"},
            {**AUTOHEAL_MR, "source_branch": "autoheal/"},
            {k: v for k, v in AUTOHEAL_MR.items() if k != "source_branch"},
        ]
        for mr in cases:
            code, out, err, reqs = run(["postmortem", "40", "--record", self.record(PROMOTED)],
                                       self.routes(mr), env=PM_ENV)
            self.assertEqual(code, 0, err)
            self.assertEqual([r["method"] for r in reqs], ["GET"], mr)
            self.assertIn("not an open autoheal merge request; nothing to do", out)

    def test_marker_for_this_pipeline_already_posted_does_nothing(self):
        notes = [{"body": "unrelated"},
                 {"body": "@ai-canary-postmortem-gitlab-ai-hackathon !40: ...\n\npostmortem-dispatch: pipeline 5151"}]
        code, out, _, reqs = run(["postmortem", "40", "--record", self.record(PROMOTED)],
                                 self.routes(notes=notes), env=PM_ENV)
        self.assertEqual(code, 0)
        self.assertEqual([r["method"] for r in reqs], ["GET", "GET"])
        self.assertIn("already dispatched for pipeline 5151; nothing to do", out)

    def test_marker_of_another_pipeline_still_dispatches(self):
        notes = [{"body": "postmortem-dispatch: pipeline 515"}, {"body": "postmortem-dispatch: pipeline 51510"}]
        code, _, err, reqs = run(["postmortem", "40", "--record", self.record(PROMOTED)],
                                 self.routes(notes=notes), env=PM_ENV)
        self.assertEqual(code, 0, err)
        self.assertEqual([r["method"] for r in reqs], ["GET", "GET", "POST"])

    def test_pipeline_id_falls_back_to_the_record_and_is_validated(self):
        code, out, err, reqs = run(["postmortem", "40", "--record", self.record(PROMOTED)], self.routes())
        self.assertEqual(code, 0, err)
        self.assertTrue(reqs[2]["body"]["body"].endswith("postmortem-dispatch: pipeline 5151"))
        code, _, err, reqs = run(["postmortem", "40", "--record", self.record(PROMOTED)],
                                 env={**ENV, "CI_PIPELINE_ID": "51; x"})
        self.assertEqual((code, reqs), (1, []))
        self.assertIn("pipeline id must be a positive integer", err)

    def test_mr_iid_is_validated(self):
        code, _, err, reqs = run(["postmortem", "40; rm", "--record", self.record(PROMOTED)], env=PM_ENV)
        self.assertEqual((code, reqs), (1, []))
        self.assertIn("merge request iid must be a positive integer", err)

    def test_api_error_exits_1_without_the_token(self):
        routes = self.routes()
        routes[("POST", f"{API}/merge_requests/40/notes")] = http_error(
            f"{API}/merge_requests/40/notes", 403, {"message": "403 Forbidden"})
        code, out, err, _ = run(["postmortem", "40", "--record", self.record(PROMOTED)], routes, env=PM_ENV)
        self.assertEqual(code, 1)
        self.assertEqual(err.strip(), 'duo dispatch postmortem failed: POST /projects/87777765/merge_requests/40/'
                                      'notes: HTTP 403 ("403 Forbidden")')
        self.assertNotIn(TOKEN, out + err)
        self.assertNotIn("PRIVATE-TOKEN", out + err)


SHA = "fedcba9876543210fedcba9876543210fedcba98"
RC_ENV = {**ENV, "CI_PIPELINE_ID": "6000", "CI_COMMIT_SHA": SHA, "CI_DEFAULT_BRANCH": "main",
          "CI_PIPELINE_URL": "https://gitlab.example/g/showcase/-/pipelines/6000"}
RELEASED = {**PROMOTED, "ci": {**RECORD["ci"], "pipeline_id": "6000", "commit_sha": SHA}}
MERGED_MR = {**AUTOHEAL_MR, "state": "merged"}
INCIDENT = {"iid": 12, "state": "opened", "labels": ["incident", "priority::high", "status::mitigated"],
            "title": "Incident: canary rolled back abc1234d (pipeline 4242)"}
COMMIT_MRS = f"{API}/repository/commits/{SHA}/merge_requests"
REG_SEARCH = (f"{API}/issues?state=opened&labels=type%3A%3Aregression&search=Regression%3A+gateway+canary"
              "+rejected+at+abc1234d&in=title&per_page=100")
INC_NOTES = f"{API}/issues/12/notes?sort=desc&per_page=100"
INCIDENT_NOTE = (
    "Released and verified: fix !40 merged as fedcba98; main pipeline 6000 canary PROMOTE "
    "(https://gitlab.example/g/showcase/-/pipelines/6000). Closing this incident.\n\n"
    "release-close: pipeline 6000"
)


class ReleaseClose(RecordFiles):
    """#34: after main's canary promotes a merged autoheal fix, CI closes the incident and regression."""

    def routes(self, mrs: list | None = None, incident: dict | None = None, regressions: list | None = None,
               notes: list | None = None) -> dict:
        r = {
            ("GET", COMMIT_MRS): [MERGED_MR] if mrs is None else mrs,
            ("GET", f"{API}/issues/12"): INCIDENT if incident is None else incident,
            ("GET", INC_NOTES): [] if notes is None else notes,
            ("POST", f"{API}/issues/12/notes"): {"id": 1},
            ("PUT", f"{API}/issues/12"): {"iid": 12},
            ("GET", REG_SEARCH): [] if regressions is None else regressions,
        }
        for i in (13, 14, 15):
            r[("POST", f"{API}/issues/{i}/notes")] = {"id": i}
            r[("PUT", f"{API}/issues/{i}")] = {"iid": i}
        return r

    def close(self, routes: dict, record: dict | None = None, env: dict | None = None):
        return run(["release-close", "--record", self.record(RELEASED if record is None else record)],
                   routes, env=RC_ENV if env is None else env)

    def test_closes_the_incident_with_a_note_and_the_resolved_label(self):
        code, out, err, reqs = self.close(self.routes())
        self.assertEqual(code, 0, err)
        self.assertEqual([(r["method"], r["url"]) for r in reqs], [
            ("GET", COMMIT_MRS), ("GET", f"{API}/issues/12"), ("GET", INC_NOTES),
            ("POST", f"{API}/issues/12/notes"), ("PUT", f"{API}/issues/12"), ("GET", REG_SEARCH)])
        self.assertEqual(reqs[3]["body"], {"body": INCIDENT_NOTE})
        self.assertEqual(reqs[4]["body"], {
            "state_event": "close", "add_labels": "status::resolved",
            "remove_labels": "status::mitigated,status::triaged,status::ready"})
        self.assertIn("release-close: closed incident #12 (fix !40, pipeline 6000)", out)
        self.assertIn("release-close: no open regression issue for abc1234d", out)

    def test_promote_pending_approval_also_closes(self):
        code, out, err, reqs = self.close(self.routes(), {**RELEASED, "decision": "PROMOTE_PENDING_APPROVAL"})
        self.assertEqual(code, 0, err)
        self.assertIn("canary PROMOTE_PENDING_APPROVAL (", reqs[3]["body"]["body"])

    def test_not_promoted_or_no_record_does_nothing(self):
        for path, expect in self.gating_cases():
            code, out, err, reqs = run(["release-close", "--record", path], env=RC_ENV)
            self.assertEqual((code, reqs), (0, []), path)
            self.assertIn(expect, out)
            self.assertIn("nothing to do", out)

    def test_only_merged_autoheal_mrs_count(self):
        mrs = [{**MERGED_MR, "iid": 41, "labels": ["bug"]}, {**MERGED_MR, "iid": 42, "state": "opened"},
               {**MERGED_MR, "iid": 43, "state": "closed"}, "junk"]
        code, out, err, reqs = self.close(self.routes(mrs))
        self.assertEqual(code, 0, err)
        self.assertEqual([r["method"] for r in reqs], ["GET"])
        self.assertIn("no merged autoheal merge request in fedcba98; nothing to do", out)

    def test_incident_iid_from_the_description_first_line(self):
        mr = {**MERGED_MR, "description": "  Incident: #12  \r\nRegression: #99", "title": "Autoheal: x (incident #77)"}
        code, _, err, reqs = self.close(self.routes([mr]))
        self.assertEqual(code, 0, err)
        self.assertEqual(reqs[1]["url"], f"{API}/issues/12")

    def test_incident_iid_falls_back_to_the_title(self):
        for desc in ("Root cause: ...\nIncident: #77", None, "Incident: #12abc", "Incident: #0"):
            mr = {**MERGED_MR, "description": desc, "title": "Autoheal: revert the cap (incident #12)"}
            code, _, err, reqs = self.close(self.routes([mr]))
            self.assertEqual(code, 0, err)
            self.assertEqual(reqs[1]["url"], f"{API}/issues/12", desc)

    def test_mr_naming_no_incident_is_skipped(self):
        mr = {**MERGED_MR, "description": "no link", "title": "Autoheal: revert (incident #12) later"}
        code, out, err, reqs = self.close(self.routes([mr]))
        self.assertEqual(code, 0, err)
        self.assertEqual([r["method"] for r in reqs], ["GET"])
        self.assertIn("release-close: !40 names no incident; skipped", out)

    def test_issue_that_is_not_a_canary_incident_is_left_alone(self):
        for issue in ({**INCIDENT, "labels": ["bug"]}, {**INCIDENT, "title": "Some other bug (pipeline 4242)"}):
            code, out, err, reqs = self.close(self.routes(incident=issue))
            self.assertEqual(code, 0, err)
            self.assertEqual([r["method"] for r in reqs], ["GET", "GET"])
            self.assertIn("release-close: #12 is not a canary incident; skipped", out)

    def test_closed_incident_is_not_touched_again_but_regressions_still_close(self):
        reg = [{"iid": 13, "title": "Regression: gateway canary rejected at abc1234d on main"}]
        code, out, err, reqs = self.close(self.routes(incident={**INCIDENT, "state": "closed"}, regressions=reg))
        self.assertEqual(code, 0, err)
        self.assertEqual([(r["method"], r["url"]) for r in reqs], [
            ("GET", COMMIT_MRS), ("GET", f"{API}/issues/12"), ("GET", REG_SEARCH),
            ("POST", f"{API}/issues/13/notes"), ("PUT", f"{API}/issues/13")])
        self.assertIn("release-close: incident #12 is already closed; nothing to do", out)

    def test_incident_note_for_this_pipeline_is_not_posted_twice(self):
        notes = [{"body": "other"}, {"body": INCIDENT_NOTE}]
        code, out, err, reqs = self.close(self.routes(notes=notes))
        self.assertEqual(code, 0, err)
        self.assertEqual([r["method"] for r in reqs], ["GET", "GET", "GET", "PUT", "GET"])
        self.assertIn("closed incident #12", out)

    def test_regression_issues_for_the_incident_sha_are_closed_exactly(self):
        regs = [
            {"iid": 13, "title": "Regression: gateway canary rejected at abc1234d on main"},
            {"iid": 14, "title": "Regression: gateway canary rejected at abc1234d"},
            {"iid": 20, "title": "Regression: gateway canary rejected at abc1234de on main"},  # other sha
            {"iid": 21, "title": "Regression: gateway canary rejected at 99999999 on main"},
            {"iid": 22, "title": "Re: Regression: gateway canary rejected at abc1234d on main"},
            {"iid": 23, "title": "regression: gateway canary rejected at abc1234d on main"},
            {"iid": "x", "title": "Regression: gateway canary rejected at abc1234d on main"},
        ]
        code, out, err, reqs = self.close(self.routes(regressions=regs))
        self.assertEqual(code, 0, err)
        touched = [(r["method"], r["url"]) for r in reqs[6:]]
        self.assertEqual(touched, [("POST", f"{API}/issues/13/notes"), ("PUT", f"{API}/issues/13"),
                                   ("POST", f"{API}/issues/14/notes"), ("PUT", f"{API}/issues/14")])
        self.assertEqual(reqs[6]["body"], {"body": (
            "Fixed by !40, merged as fedcba98; main pipeline 6000 canary PROMOTE "
            "(https://gitlab.example/g/showcase/-/pipelines/6000). Incident: #12. Closing this regression."
            "\n\nrelease-close: pipeline 6000")})
        self.assertEqual(reqs[7]["body"], {"state_event": "close"})
        self.assertIn("release-close: closed regression #13 (fix !40, incident #12)", out)
        self.assertIn("release-close: closed regression #14 (fix !40, incident #12)", out)
        self.assertNotIn("#20", out)

    def test_incident_title_without_a_sha_skips_the_regression_search(self):
        code, out, err, reqs = self.close(self.routes(
            incident={**INCIDENT, "title": "Incident: canary rolled back unknown (pipeline 4242)"}))
        self.assertEqual(code, 0, err)
        self.assertNotIn("GET", [r["method"] for r in reqs[5:]])
        self.assertIn("release-close: incident #12 names no commit sha; regression issues not searched", out)

    def test_commit_sha_and_pipeline_fall_back_to_the_record_and_are_validated(self):
        env = {k: v for k, v in RC_ENV.items() if k not in ("CI_COMMIT_SHA", "CI_PIPELINE_ID", "CI_PIPELINE_URL")}
        code, _, err, reqs = self.close(self.routes(), env=env)
        self.assertEqual(code, 0, err)
        self.assertEqual(reqs[3]["body"]["body"], INCIDENT_NOTE.replace(
            "https://gitlab.example/g/showcase/-/pipelines/6000", RECORD["ci"]["pipeline_url"]))
        for bad in ({"CI_COMMIT_SHA": "HEAD; rm"}, {"CI_PIPELINE_ID": "6000x"}):
            code, _, err, reqs = self.close(self.routes(), env={**RC_ENV, **bad})
            self.assertEqual((code, reqs), (1, []), bad)
            self.assertRegex(err, "commit sha must be|pipeline id must be")

    def test_api_error_exits_1_without_the_token(self):
        routes = self.routes()
        routes[("PUT", f"{API}/issues/12")] = urllib.error.URLError(socket.timeout("timed out"))
        code, out, err, _ = self.close(routes)
        self.assertEqual(code, 1)
        self.assertEqual(err.strip(), "duo dispatch release-close failed: PUT /projects/87777765/issues/12: "
                                      "timed out after 15 s")
        self.assertNotIn(TOKEN, out + err)
        self.assertNotIn("PRIVATE-TOKEN", out + err)


if __name__ == "__main__":
    unittest.main()
