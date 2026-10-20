"""Unit tests for verdict.py (#23, H2). Standard library only:
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'

Decision tests use recorded sample fixtures (testdata/*.json). The HTTP tests run verdict.py's real
sender against a local stub server that answers like the gateway behind a weighted split (stable /
canary by request number, x-urumi-track header, JSON or SSE bodies). Nothing under test is mocked.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verdict  # noqa: E402

TESTDATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata")
KEY = "urk_test-key-must-never-be-printed-5f2a"


def fixture(name: str) -> list[verdict.Sample]:
    return verdict.load_samples(os.path.join(TESTDATA, f"{name}.json"))


def run_main(args: list[str], env: dict | None = None) -> tuple[int, dict, str, str]:
    """main(args) -> (exit code, parsed JSON report or {}, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    old_env = dict(os.environ)
    os.environ.pop("CANARY_API_KEY", None)
    os.environ.update(env or {})
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = verdict.main(args)
            except SystemExit as e:
                code = e.code
    finally:
        os.environ.clear()
        os.environ.update(old_env)
    text = out.getvalue()
    return code, (json.loads(text) if text.strip() else {}), text, err.getvalue()


class DecisionFromFixtures(unittest.TestCase):
    th = verdict.Thresholds()

    def verdict_of(self, name: str) -> tuple[str, list[str]]:
        r = verdict.report(fixture(name), self.th)
        return r["verdict"], r["reasons"]

    def test_healthy_canary_is_promoted(self):
        v, reasons = self.verdict_of("good")
        self.assertEqual(v, "PROMOTE")
        self.assertEqual(len(reasons), 3)

    def test_canary_errors_roll_back(self):
        v, reasons = self.verdict_of("canary-errors")
        self.assertEqual(v, "ROLLBACK")
        self.assertTrue(any("error rate 50.0%" in r for r in reasons), reasons)

    def test_slow_canary_rolls_back_on_p95(self):
        v, reasons = self.verdict_of("canary-slow")
        self.assertEqual(v, "ROLLBACK")
        self.assertEqual(len(reasons), 1)
        self.assertIn("p95", reasons[0])

    def test_tool_errors_roll_back_on_success_ratio_only(self):
        r = verdict.report(fixture("canary-tool-errors"), self.th)
        self.assertEqual(r["verdict"], "ROLLBACK")
        self.assertEqual(r["canary"]["error_rate"], 0)
        self.assertEqual(len(r["reasons"]), 1)
        self.assertIn("success", r["reasons"][0])

    def test_too_few_canary_samples_hold(self):
        v, reasons = self.verdict_of("few-canary")
        self.assertEqual(v, "HOLD")
        self.assertIn("canary served only 6", reasons[0])

    def test_unhealthy_stable_holds(self):
        v, reasons = self.verdict_of("stable-unhealthy")
        self.assertEqual(v, "HOLD")
        self.assertTrue(any("stable itself is unhealthy" in r for r in reasons), reasons)

    def test_dead_canary_unattributed_failures_roll_back(self):
        # Proxy 502s carry no x-urumi-track; with 20% of traffic failing and stable healthy, the
        # canary is blamed even though it answered (almost) nothing itself.
        r = verdict.report(fixture("dead-canary"), self.th)
        self.assertEqual(r["samples"]["unattributed_errors"], 12)
        # Too few attributed canary samples is a HOLD before any other check.
        self.assertEqual(r["verdict"], "HOLD")
        samples = fixture("dead-canary") + fixture("good")[48:]
        r = verdict.report(samples, self.th)
        self.assertEqual(r["verdict"], "ROLLBACK")
        self.assertTrue(any("without an x-urumi-track" in x for x in r["reasons"]), r["reasons"])

    def test_report_shape(self):
        r = verdict.report(fixture("good"), self.th, {"tool": "woo__list_orders"})
        self.assertEqual(
            set(r), {"verdict", "reasons", "stable", "canary", "samples", "thresholds", "tool"}
        )
        self.assertEqual(r["samples"], {"total": 60, "stable": 48, "canary": 12, "unknown": 0,
                                        "unattributed_errors": 0})
        for track in ("stable", "canary"):
            self.assertEqual(
                set(r[track]),
                {"n", "errors", "error_rate", "tool_ok", "success_rate", "p50_ms", "p95_ms"},
            )


class Thresholds(unittest.TestCase):
    def summary(self, n, errors=0, ok=None, p95=200.0):
        return {"n": n, "errors": errors, "error_rate": errors / n, "tool_ok": ok if ok is not None
                else n - errors, "success_rate": (ok if ok is not None else n - errors) / n,
                "p50_ms": p95, "p95_ms": p95}

    def test_error_rate_limit_is_stable_plus_delta_capped_at_max(self):
        th = verdict.Thresholds(min_success=0.5)  # isolate the error-rate check
        stable = self.summary(100, errors=2)  # 2% -> limit 7%
        self.assertEqual(verdict.decide(stable, self.summary(100, 7), th)[0], "PROMOTE")
        self.assertEqual(verdict.decide(stable, self.summary(100, 8), th)[0], "ROLLBACK")
        stable = self.summary(100, errors=8)  # 8% + 5 = 13% -> capped at 10%
        self.assertEqual(verdict.decide(stable, self.summary(100, 10), th)[0], "PROMOTE")
        self.assertEqual(verdict.decide(stable, self.summary(100, 11), th)[0], "ROLLBACK")

    def test_latency_limit_is_factor_times_stable_plus_slack(self):
        th = verdict.Thresholds()
        stable = self.summary(50, p95=400.0)  # limit 1.5 * 400 + 200 = 800
        self.assertEqual(verdict.decide(stable, self.summary(20, p95=800.0), th)[0], "PROMOTE")
        self.assertEqual(verdict.decide(stable, self.summary(20, p95=801.0), th)[0], "ROLLBACK")

    def test_success_boundary(self):
        th = verdict.Thresholds()
        stable = self.summary(100)
        self.assertEqual(verdict.decide(stable, self.summary(20, ok=19), th)[0], "PROMOTE")  # 95%
        self.assertEqual(verdict.decide(stable, self.summary(20, ok=18), th)[0], "ROLLBACK")

    def test_p95_nearest_rank(self):
        self.assertIsNone(verdict.p95([]))
        self.assertEqual(verdict.p95([5.0]), 5.0)
        self.assertEqual(verdict.p95([float(i) for i in range(1, 101)]), 95.0)
        self.assertEqual(verdict.p95([float(i) for i in range(1, 21)]), 19.0)


class Classify(unittest.TestCase):
    ok_body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": []}}).encode()

    def test_json_result(self):
        s = verdict.classify(200, {"x-urumi-track": "canary", "content-type": "application/json"},
                             self.ok_body, 12.0)
        self.assertEqual((s.track, s.tool_ok, s.http_error), ("canary", True, False))

    def test_sse_result(self):
        body = b"event: message\ndata: " + self.ok_body + b"\n\n"
        s = verdict.classify(200, {"x-urumi-track": "stable", "content-type": "text/event-stream"},
                             body, 1.0)
        self.assertTrue(s.tool_ok)

    def test_tool_error_and_rpc_error_are_2xx_failures(self):
        is_error = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"isError": True}}).encode()
        rpc = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32603}}).encode()
        for body, why in ((is_error, "tool error"), (rpc, "JSON-RPC error"), (b"<html>", "no JSON-RPC response")):
            s = verdict.classify(200, {"x-urumi-track": "stable"}, body, 1.0)
            self.assertEqual((s.tool_ok, s.http_error, s.error), (False, False, why))

    def test_http_errors_and_no_answer(self):
        s = verdict.classify(500, {"x-urumi-track": "canary"}, b"{}", 1.0)
        self.assertEqual((s.track, s.http_error, s.error), ("canary", True, "HTTP 500"))
        s = verdict.classify(502, {}, b"Bad Gateway", 1.0)
        self.assertEqual(s.track, "unknown")
        s = verdict.classify(None, {}, b"", 1.0)
        self.assertEqual((s.track, s.status, s.http_error), ("unknown", None, True))


class StubGateway(BaseHTTPRequestHandler):
    """Every 5th request is the canary (20%); the canary fails `canary_fail_every`-th of its calls."""

    counter = 0
    lock = threading.Lock()
    canary_fail_every = 0
    seen_auth: list[str] = []

    def log_message(self, *args):  # keep test output clean
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with StubGateway.lock:
            StubGateway.counter += 1
            n = StubGateway.counter
            StubGateway.seen_auth.append(self.headers.get("authorization", ""))
        canary = n % 5 == 0
        track = "canary" if canary else "stable"
        if self.headers.get("authorization") != f"Bearer {KEY}":
            return self.reply(401, track, b'{"error":{"code":"UNAUTHENTICATED"}}')
        if canary and self.canary_fail_every and (n // 5) % self.canary_fail_every == 0:
            return self.reply(500, track, b'{"error":{"code":"INTERNAL"}}')
        assert body["method"] == "tools/call" and body["params"]["name"] == "woo__list_orders"
        payload = json.dumps({"jsonrpc": "2.0", "id": body["id"],
                              "result": {"content": [{"type": "text", "text": "[]"}]}}).encode()
        if n % 2:
            self.reply(200, track, b"event: message\ndata: " + payload + b"\n\n", "text/event-stream")
        else:
            self.reply(200, track, payload)

    def reply(self, code, track, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("x-urumi-track", track)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class EndToEndAgainstStub(unittest.TestCase):
    def setUp(self):
        StubGateway.counter = 0
        StubGateway.canary_fail_every = 0
        StubGateway.seen_auth = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubGateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/mcp"
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "key")
        with open(self.key_file, "w") as f:
            f.write(KEY + "\n")
        self.out = os.path.join(self.tmp.name, "verdict.json")

    def tearDown(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        self.tmp.cleanup()

    def test_promote_writes_json_and_never_prints_the_key(self):
        code, report, stdout, stderr = run_main(
            ["--url", self.url, "--key-file", self.key_file, "--out", self.out])
        self.assertEqual(code, 0, report)
        self.assertEqual(report["verdict"], "PROMOTE")
        self.assertEqual(report["samples"], {"total": 60, "stable": 48, "canary": 12, "unknown": 0,
                                             "unattributed_errors": 0})
        with open(self.out) as f:
            self.assertEqual(json.load(f), report)
        self.assertTrue(all(a == f"Bearer {KEY}" for a in StubGateway.seen_auth))
        with open(self.out) as f:
            self.assertNotIn(KEY, stdout + stderr + f.read())
        self.assertIn("VERDICT: PROMOTE", stderr)

    def test_failing_canary_rolls_back_with_exit_1(self):
        StubGateway.canary_fail_every = 2
        code, report, *_ = run_main(["--url", self.url, "--key-file", self.key_file, "--out", ""])
        self.assertEqual((code, report["verdict"]), (1, "ROLLBACK"))
        self.assertEqual(report["canary"]["error_rate"], 0.5)
        self.assertEqual(report["stable"]["error_rate"], 0)

    def test_sends_more_until_the_canary_has_min_samples(self):
        code, report, *_ = run_main(["--url", self.url, "--key-file", self.key_file, "--out", "",
                                     "--requests", "20", "--min-samples", "10"])
        self.assertEqual(code, 0, report)
        self.assertGreaterEqual(report["samples"]["canary"], 10)
        self.assertEqual(report["samples"]["total"], 50)

    def test_hold_with_exit_2_when_capped_before_enough_canary_samples(self):
        code, report, *_ = run_main(["--url", self.url, "--key-file", self.key_file, "--out", "",
                                     "--requests", "20", "--max-requests", "30"])
        self.assertEqual((code, report["verdict"]), (2, "HOLD"))
        self.assertEqual(report["samples"]["total"], 30)

    def test_key_from_env(self):
        code, report, *_ = run_main(["--url", self.url, "--out", "", "--requests", "10",
                                     "--min-samples", "2"], env={"CANARY_API_KEY": KEY})
        self.assertEqual(code, 0, report)

    def test_wrong_key_is_not_a_promote(self):
        code, report, stdout, stderr = run_main(
            ["--url", self.url, "--out", "", "--requests", "20"], env={"CANARY_API_KEY": "urk_wrong"})
        self.assertNotEqual(code, 0)
        self.assertNotIn("urk_wrong", stdout + stderr)

    def test_unreachable_gateway_is_not_a_promote(self):
        self.server.shutdown()
        self.server.server_close()
        self.server = None
        code, report, *_ = run_main(["--url", self.url, "--key-file", self.key_file, "--out", "",
                                     "--requests", "5", "--max-requests", "5", "--timeout", "2"])
        self.assertEqual((code, report["verdict"]), (2, "HOLD"))
        self.assertEqual(report["samples"]["unattributed_errors"], 5)


class Usage(unittest.TestCase):
    def test_no_key_and_bad_flags_exit_3(self):
        self.assertEqual(run_main(["--out", ""])[0], 3)
        self.assertEqual(run_main(["--requests", "0"])[0], 3)
        self.assertEqual(run_main(["--args", "[1]"])[0], 3)
        self.assertEqual(run_main(["--nope"])[0], 3)

    def test_samples_file_mode_exit_codes(self):
        for name, code in (("good", 0), ("canary-errors", 1), ("few-canary", 2)):
            self.assertEqual(
                run_main(["--samples-file", os.path.join(TESTDATA, f"{name}.json"), "--out", ""])[0],
                code, name)


if __name__ == "__main__":
    unittest.main()
