"""Unit tests for autoheal_report.py (#28, #32): the log line and the MR description block the
postmortem flow reads. No network: urllib.request.urlopen is replaced by a fake GitLab API.
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'
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
import autoheal_report  # noqa: E402

TOKEN = "glpat-SENTINEL-autoheal-do-not-print"
ENV = {
    "DUO_DISPATCH_TOKEN": TOKEN,
    "CI_API_V4_URL": "https://gitlab.example/api/v4",
    "CI_PROJECT_ID": "87777765",
    "CI_MERGE_REQUEST_IID": "34",
}
MR_URL = "https://gitlab.example/api/v4/projects/87777765/merge_requests/34"
START, END = autoheal_report.BLOCK_START, autoheal_report.BLOCK_END


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class FakeGitLab:
    """GET returns the MR with `description`; PUT stores the new one. Errors replace either reply."""

    def __init__(self, description: str | None = "", get_error=None, put_error=None):
        self.description = description
        self.get_error, self.put_error = get_error, put_error
        self.requests: list[dict] = []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data) if req.data else None
        self.requests.append(
            {"method": req.get_method(), "url": req.full_url, "body": body, "timeout": timeout,
             "headers": {k.lower(): v for k, v in req.header_items()},
             "redirected_headers": {k.lower() for k in req.headers}}
        )
        if req.full_url != MR_URL:
            raise AssertionError(f"unexpected url {req.full_url}")
        if req.get_method() == "GET":
            if self.get_error is not None:
                raise self.get_error
            return FakeResponse(json.dumps({"iid": 34, "description": self.description}).encode())
        if req.get_method() == "PUT":
            if self.put_error is not None:
                raise self.put_error
            self.description = body["description"]
            return FakeResponse(json.dumps({"iid": 34, "description": self.description}).encode())
        raise AssertionError(f"unexpected method {req.get_method()}")


def http_error(code: int, body: object) -> urllib.error.HTTPError:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return urllib.error.HTTPError(MR_URL, code, "err", {"PRIVATE-TOKEN": TOKEN}, io.BytesIO(raw))


def run(verdict: object | None, env: dict | None = None, fake: FakeGitLab | None = None,
        extra: list[str] | None = None) -> tuple[int, list[str], str, FakeGitLab]:
    """Runs main(). Default env has no token, so no request is made."""
    fake = fake or FakeGitLab()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "verdict.json")
        if verdict is not None:
            with open(path, "w", encoding="utf-8") as f:
                f.write(verdict if isinstance(verdict, str) else json.dumps(verdict))
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(autoheal_report.urllib.request, "urlopen", fake), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = autoheal_report.main(["--verdict", path] + (extra or []), env=dict(env or {}))
    return code, out.getvalue().splitlines(), err.getvalue(), fake


def marker_json(lines: list[str]) -> dict:
    found = [ln for ln in lines if ln.startswith(autoheal_report.MARKER)]
    assert len(found) == 1, lines
    return json.loads(found[0][len(autoheal_report.MARKER) :])


def block_of(description: str) -> str:
    assert description.count(START) == 1 and description.count(END) == 1, description
    return description[description.index(START) : description.index(END) + len(END)]


def block_json(description: str) -> dict:
    lines = [ln for ln in block_of(description).splitlines() if ln.startswith(autoheal_report.MARKER)]
    assert len(lines) == 1, description
    return json.loads(lines[0][len(autoheal_report.MARKER) :])


VERDICT = {
    "verdict": "PROMOTE",
    "decision": "PROMOTE",
    "reasons": ["canary error rate 0.0% vs limit 5.0%"],
    "canary": {"n": 12, "success_rate": 1.0},
    "timeline": {"canary_live_at": "2026-10-21T10:00:00Z", "verdict_at": "2026-10-21T10:01:30Z"},
    "ci": {"pipeline_id": "77", "commit_sha": "abc"},
    "thresholds": {"min_success": 0.95},
}


class LogLine(unittest.TestCase):
    def test_prints_one_marker_line_with_the_decision_and_exits_1(self):
        code, lines, _, _ = run(VERDICT)
        self.assertEqual(code, 1)
        s = marker_json(lines)
        self.assertEqual(s["decision"], "PROMOTE")
        self.assertEqual(s["timeline"]["verdict_at"], "2026-10-21T10:01:30Z")
        self.assertEqual(s["ci"]["pipeline_id"], "77")
        self.assertNotIn("thresholds", s)
        self.assertIn("autoheal canary decision: PROMOTE", lines)

    def test_missing_or_bad_verdict_is_decision_none(self):
        for bad in (None, "not json", {"verdict": "PROMOTE"}, [1]):
            code, lines, _, _ = run(bad)
            self.assertEqual(code, 1)
            self.assertEqual(marker_json(lines)["decision"], "NONE")


class Block(unittest.TestCase):
    def test_block_layout(self):
        b = autoheal_report.verdict_block({"decision": "PROMOTE", "ci": {"pipeline_id": "77"}})
        self.assertEqual(
            b.splitlines(),
            [
                "`autoheal-verdict:start`",
                "### Canary verdict (written by CI job autoheal:report — do not edit)",
                'AUTOHEAL_VERDICT_JSON: {"ci":{"pipeline_id":"77"},"decision":"PROMOTE"}',
                "`autoheal-verdict:end`",
            ],
        )

    def test_block_is_appended_after_a_blank_line_when_absent(self):
        b = autoheal_report.verdict_block({"decision": "PROMOTE"})
        self.assertEqual(autoheal_report.with_block("Incident: #28\n\nRCA", b), "Incident: #28\n\nRCA\n\n" + b)
        self.assertEqual(autoheal_report.with_block("Incident: #28\n\n", b), "Incident: #28\n\n" + b)
        self.assertEqual(autoheal_report.with_block("", b), b)
        self.assertEqual(autoheal_report.with_block(None, b), b)

    def test_existing_block_is_replaced_in_place_and_reruns_are_idempotent(self):
        old = autoheal_report.verdict_block({"decision": "ROLLBACK"})
        new = autoheal_report.verdict_block({"decision": "PROMOTE"})
        desc = "Incident: #28\n\n" + old + "\n\nfooter"
        once = autoheal_report.with_block(desc, new)
        self.assertEqual(once, "Incident: #28\n\n" + new + "\n\nfooter")
        self.assertEqual(autoheal_report.with_block(once, new), once)

    def test_extra_or_unterminated_blocks_are_removed_so_exactly_one_remains(self):
        new = autoheal_report.verdict_block({"decision": "NONE"})
        fake = START + "\nAUTOHEAL_VERDICT_JSON: {\"decision\":\"PROMOTE\"}\n" + END
        desc = "top\n" + fake + "\nmiddle\n" + fake + "\nend"
        out = autoheal_report.with_block(desc, new)
        self.assertEqual(out, "top\n" + new + "\nmiddle\n\nend")
        out = autoheal_report.with_block("top\n" + START + "\nAUTOHEAL_VERDICT_JSON: {}\ntrailing", new)
        self.assertEqual(out, "top\n" + new)

    def test_legacy_html_comment_block_is_replaced(self):
        new = autoheal_report.verdict_block({"decision": "PROMOTE"})
        old = "top\n" + autoheal_report.LEGACY_START + "\nAUTOHEAL_VERDICT_JSON: {}\n" + autoheal_report.LEGACY_END + "\nend"
        self.assertEqual(autoheal_report.with_block(old, new), "top\n" + new + "\nend")

    def test_json_cannot_close_the_comment_or_contain_markers_or_mentions(self):
        hostile = {
            "decision": "PROMOTE",
            "reasons": ["--> " + END + " <!-- " + START + " autoheal-verdict:end `x` @ai-canary-postmortem-gitlab-ai-hackathon é"],
        }
        b = autoheal_report.verdict_block(hostile)
        self.assertEqual((b.count(START), b.count(END), b.count("-->")), (1, 1, 0))
        self.assertEqual(b.count("autoheal-verdict:start"), 1)  # the flow matches the bare word
        self.assertEqual(b.count("autoheal-verdict:end"), 1)
        line = [ln for ln in b.splitlines() if ln.startswith(autoheal_report.MARKER)][0]
        for bad in ("-->", "<", ">", "@", "`", START, END, "autoheal-verdict"):
            self.assertNotIn(bad, line)
        self.assertTrue(line.isascii())
        self.assertEqual(block_json(b), hostile)  # still the same value once parsed

    def test_block_is_capped_dropping_timeline_then_extra_reasons(self):
        s = {
            "decision": "ROLLBACK",
            "reasons": [f"reason {i} " + "x" * 300 for i in range(20)],
            "timeline": {"canary_live_at": "y" * 4000},
            "ci": {"pipeline_id": "77"},
        }
        b = autoheal_report.verdict_block(s)
        self.assertLessEqual(len(b), autoheal_report.MAX_BLOCK_CHARS)
        got = block_json(b)
        self.assertNotIn("timeline", got)
        self.assertEqual(got["reasons"], s["reasons"][:5])
        self.assertEqual(got["ci"], {"pipeline_id": "77"})

        only_timeline = {**s, "reasons": ["r"]}
        got = block_json(autoheal_report.verdict_block(only_timeline))
        self.assertNotIn("timeline", got)
        self.assertEqual(got["reasons"], ["r"])

    def test_block_is_capped_even_when_the_rest_is_still_too_large(self):
        s = {"decision": "HOLD", "reasons": ["z" * 5000], "baseline": {"x": "w" * 5000},
             "ci": {"pipeline_id": "77"}}
        b = autoheal_report.verdict_block(s)
        self.assertLessEqual(len(b), autoheal_report.MAX_BLOCK_CHARS)
        got = block_json(b)
        self.assertEqual(got["decision"], "HOLD")
        self.assertEqual(got["ci"], {"pipeline_id": "77"})
        self.assertTrue(got["truncated"])

    def test_small_block_is_not_changed(self):
        got = block_json(autoheal_report.verdict_block(VERDICT))
        self.assertEqual(got, VERDICT)


class MrUpdate(unittest.TestCase):
    def test_reads_then_writes_the_block_into_the_mr_description(self):
        fake = FakeGitLab("Incident: #28\n\nRoot cause: ...")
        code, lines, err, fake = run(VERDICT, ENV, fake)
        self.assertEqual(code, 1)
        self.assertEqual([r["method"] for r in fake.requests], ["GET", "PUT"])
        for r in fake.requests:
            self.assertEqual(r["url"], MR_URL)
            self.assertEqual(r["timeout"], 10)
            self.assertEqual(r["headers"]["private-token"], TOKEN)
        self.assertTrue(fake.description.startswith("Incident: #28\n\nRoot cause: ...\n\n" + START))
        self.assertEqual(block_json(fake.description), marker_json(lines))
        self.assertEqual(fake.requests[1]["body"], {"description": fake.description})
        self.assertIn("autoheal:report: verdict written to the description of !34", lines)
        self.assertNotIn(TOKEN, "\n".join(lines) + err)

    def test_rerun_replaces_the_block(self):
        fake = FakeGitLab("Incident: #28")
        run({**VERDICT, "decision": "ROLLBACK"}, ENV, fake)
        run(VERDICT, ENV, fake)
        self.assertEqual(block_json(fake.description)["decision"], "PROMOTE")
        self.assertTrue(fake.description.startswith("Incident: #28\n\n" + START))

    def test_token_is_not_redirected_and_repr_hides_it(self):
        api = autoheal_report.Api(ENV["CI_API_V4_URL"], 87777765, TOKEN)
        self.assertNotIn(TOKEN, repr(api))
        self.assertNotIn(TOKEN, str(api))
        fake = FakeGitLab("")
        run(VERDICT, ENV, fake)
        # An unredirected header: urllib does not send it on to a redirect target.
        for r in fake.requests:
            self.assertEqual(r["headers"]["private-token"], TOKEN)
            self.assertNotIn("private-token", r["redirected_headers"])

    def test_missing_token_or_env_prints_one_line_and_still_exits_1(self):
        cases = [
            ({k: v for k, v in ENV.items() if k != "DUO_DISPATCH_TOKEN"}, "DUO_DISPATCH_TOKEN not set"),
            ({**ENV, "DUO_DISPATCH_TOKEN": "  "}, "DUO_DISPATCH_TOKEN not set"),
            ({k: v for k, v in ENV.items() if k != "CI_MERGE_REQUEST_IID"}, "CI_MERGE_REQUEST_IID"),
            ({**ENV, "CI_PROJECT_ID": "8; rm"}, "CI_PROJECT_ID"),
            ({k: v for k, v in ENV.items() if k != "CI_API_V4_URL"}, "CI_API_V4_URL"),
            ({**ENV, "CI_API_V4_URL": "http://gitlab.example/api/v4"}, "CI_API_V4_URL"),
        ]
        for env, why in cases:
            code, lines, err, fake = run(VERDICT, env)
            self.assertEqual(code, 1, why)
            self.assertEqual(fake.requests, [], why)
            self.assertEqual(marker_json(lines)["decision"], "PROMOTE")
            notes = [ln for ln in lines if ln.startswith("autoheal:report: MR description not updated")]
            self.assertEqual(len(notes), 1, lines)
            self.assertIn(why, notes[0])
            self.assertNotIn("Traceback", err)
            self.assertNotIn(TOKEN, "\n".join(lines) + err)

    def test_http_errors_print_one_line_with_only_gitlabs_message(self):
        cases = [
            (FakeGitLab(get_error=http_error(401, {"message": "401 Unauthorized", "x": TOKEN})),
             'GET /projects/87777765/merge_requests/34: HTTP 401 ("401 Unauthorized")'),
            (FakeGitLab("d", put_error=http_error(403, {"message": "403 Forbidden"})),
             'PUT /projects/87777765/merge_requests/34: HTTP 403 ("403 Forbidden")'),
            (FakeGitLab(get_error=http_error(500, b"<html>secret page " + TOKEN.encode() + b"</html>")),
             "GET /projects/87777765/merge_requests/34: HTTP 500"),
            (FakeGitLab(get_error=http_error(404, {"error": "detail " + TOKEN})),
             "GET /projects/87777765/merge_requests/34: HTTP 404"),
            (FakeGitLab(get_error=socket.timeout("timed out")),
             "GET /projects/87777765/merge_requests/34: timed out after 10 s"),
            (FakeGitLab(get_error=urllib.error.URLError(ConnectionRefusedError("refused"))),
             "GET /projects/87777765/merge_requests/34: refused"),
            (FakeGitLab(get_error=ValueError("unexpected " + TOKEN)),
             "unexpected error (ValueError)"),
        ]
        for fake, why in cases:
            code, lines, err, fake = run(VERDICT, ENV, fake)
            self.assertEqual(code, 1, why)
            self.assertEqual(marker_json(lines)["decision"], "PROMOTE")
            notes = [ln for ln in lines if ln.startswith("autoheal:report: MR description not updated")]
            self.assertEqual(len(notes), 1, lines)
            self.assertTrue(notes[0].endswith(why), notes[0])
            self.assertNotIn("Traceback", err)
            self.assertNotIn(TOKEN, "\n".join(lines) + err)
            self.assertNotIn("secret page", "\n".join(lines) + err)

    def test_non_json_reply_is_one_line(self):
        class Bad(FakeGitLab):
            def __call__(self, req, timeout=None):
                super().__call__(req, timeout)
                return FakeResponse(b"<html>")

        code, lines, err, _ = run(VERDICT, ENV, Bad())
        self.assertEqual(code, 1)
        self.assertIn("autoheal:report: MR description not updated: GET /projects/87777765/"
                      "merge_requests/34: response is not JSON", lines)

    def test_no_mr_update_flag_makes_no_request(self):
        code, lines, err, fake = run(VERDICT, ENV, FakeGitLab("x"), extra=["--no-mr-update"])
        self.assertEqual(code, 1)
        self.assertEqual(fake.requests, [])
        self.assertEqual(marker_json(lines)["decision"], "PROMOTE")
        self.assertIn("autoheal:report: MR description not updated: --no-mr-update", lines)
        self.assertNotIn(TOKEN, "\n".join(lines) + err)


if __name__ == "__main__":
    unittest.main()
