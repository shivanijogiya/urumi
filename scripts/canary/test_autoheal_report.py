"""Unit tests for autoheal_report.py (#28): the log line the postmortem flow reads.
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import autoheal_report  # noqa: E402


def run(verdict: object | None) -> tuple[int, list[str]]:
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "verdict.json")
        if verdict is not None:
            with open(path, "w", encoding="utf-8") as f:
                f.write(verdict if isinstance(verdict, str) else json.dumps(verdict))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = autoheal_report.main(["--verdict", path])
    return code, out.getvalue().splitlines()


def marker_json(lines: list[str]) -> dict:
    found = [ln for ln in lines if ln.startswith(autoheal_report.MARKER)]
    assert len(found) == 1, lines
    return json.loads(found[0][len(autoheal_report.MARKER) :])


class AutohealReport(unittest.TestCase):
    VERDICT = {
        "verdict": "PROMOTE",
        "decision": "PROMOTE",
        "reasons": ["canary error rate 0.0% vs limit 5.0%"],
        "canary": {"n": 12, "success_rate": 1.0},
        "timeline": {"canary_live_at": "2026-10-21T10:00:00Z", "verdict_at": "2026-10-21T10:01:30Z"},
        "ci": {"pipeline_id": "77", "commit_sha": "abc"},
        "thresholds": {"min_success": 0.95},
    }

    def test_prints_one_marker_line_with_the_decision_and_exits_1(self):
        code, lines = run(self.VERDICT)
        self.assertEqual(code, 1)
        s = marker_json(lines)
        self.assertEqual(s["decision"], "PROMOTE")
        self.assertEqual(s["timeline"]["verdict_at"], "2026-10-21T10:01:30Z")
        self.assertEqual(s["ci"]["pipeline_id"], "77")
        self.assertNotIn("thresholds", s)

    def test_keeps_the_shopper_fields_for_the_postmortem(self):
        shoppers = {"status": "used", "stable": {"valid": 4, "completed": 4}, "rollback": False}
        _, lines = run({**self.VERDICT, "shoppers": shoppers, "customer_voice": "It was fine."})
        s = marker_json(lines)
        self.assertEqual(s["shoppers"], shoppers)
        self.assertEqual(s["customer_voice"], "It was fine.")

    def test_missing_or_bad_verdict_is_decision_none(self):
        for bad in (None, "not json", {"verdict": "PROMOTE"}, [1]):
            code, lines = run(bad)
            self.assertEqual(code, 1)
            self.assertEqual(marker_json(lines)["decision"], "NONE")


if __name__ == "__main__":
    unittest.main()
