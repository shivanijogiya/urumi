"""Unit tests for record.jq (#24): the verdict.json that ci.sh writes and prints as the
`CANARY_VERDICT_JSON:` log line read by .gitlab/flows/incident.yaml. Runs the real jq program on a
real verdict.py report (from a recorded fixture). Needs jq; skipped without it.
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import verdict  # noqa: E402

ARGS = {
    "decision": "ROLLBACK",
    "action": "rolled-back",
    "tag": "canary-abc1234",
    "force_bad": "1",
    "risk": "",
    "weight": "20",
    "live": "2026-10-21T10:00:00Z",
    "verdict_at": "2026-10-21T10:01:30Z",
    "applied": "2026-10-21T10:02:00Z",
    "pipeline_id": "4242",
    "pipeline_url": "https://gitlab.example/p/-/pipelines/4242",
    "job_name": "canary:bad-release",
    "job_url": "",
    "sha": "abc1234def",
    "ref": "main",
    "base_sha": "0123abcd",
    "base_src": "last-promoted",
}


def record(report: dict, **overrides: str) -> dict:
    cmd = ["jq", "-c", "-f", os.path.join(HERE, "record.jq")]
    for k, val in {**ARGS, **overrides}.items():
        cmd += ["--arg", k, val]
    out = subprocess.run(cmd, input=json.dumps(report), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipUnless(shutil.which("jq"), "jq not installed")
class RecordJq(unittest.TestCase):
    def setUp(self):
        samples = verdict.load_samples(os.path.join(HERE, "testdata", "canary-errors.json"))
        self.report = verdict.report(samples, verdict.Thresholds())

    def test_keeps_the_measurements_and_adds_the_decision(self):
        r = record(self.report)
        self.assertEqual(r["verdict"], "ROLLBACK")
        self.assertEqual(r["reasons"], self.report["reasons"])
        self.assertEqual(r["canary"], self.report["canary"])
        self.assertEqual(r["decision"], "ROLLBACK")
        self.assertIs(r["force_bad"], True)
        self.assertEqual(r["canary_weight_pct"], 20)
        self.assertEqual(r["timeline"]["canary_live_at"], "2026-10-21T10:00:00Z")
        self.assertEqual(r["ci"]["pipeline_id"], "4242")
        self.assertEqual(r["ci"]["commit_sha"], "abc1234def")

    def test_empty_ci_fields_and_risk_become_null(self):
        r = record(self.report)
        self.assertIsNone(r["ci"]["job_url"])
        self.assertIsNone(r["risk"])
        self.assertEqual(record(self.report, risk="high")["risk"], "high")

    def test_records_the_stable_baseline(self):
        r = record(self.report)
        self.assertEqual(r["baseline"], {"stable_sha": "0123abcd", "source": "last-promoted"})

    def test_shopper_fields_are_null_without_shoppers(self):
        r = record(self.report)
        self.assertIsNone(r["shoppers"])
        self.assertIsNone(r["customer_voice"])

    def test_keeps_the_customer_voice_for_the_flows(self):
        good = verdict.report(
            verdict.load_samples(os.path.join(HERE, "testdata", "good.json")), verdict.Thresholds())
        voice = "I couldn't see today's orders; the store showed an error."
        tracks = {
            "stable": {"valid": 4, "completed": 4, "invalid": 0, "blockers": []},
            "canary": {"valid": 4, "completed": 1, "invalid": 0, "blockers": [voice]},
        }
        report = verdict.apply_shoppers(good, {"tracks": tracks}, verdict.ShopperThresholds())
        r = record(report)
        self.assertEqual(r["verdict"], "ROLLBACK")
        self.assertEqual(r["customer_voice"], voice)
        self.assertEqual(r["shoppers"]["status"], "used")
        self.assertIn(voice, r["reasons"][0])

    def test_force_bad_is_false_unless_1(self):
        self.assertIs(record(self.report, force_bad="0")["force_bad"], False)

    def test_compact_output_is_one_line(self):
        cmd = ["jq", "-c", "-f", os.path.join(HERE, "record.jq")]
        for k, val in ARGS.items():
            cmd += ["--arg", k, val]
        out = subprocess.run(
            cmd, input=json.dumps(self.report), capture_output=True, text=True, check=True
        ).stdout
        self.assertEqual(out.count("\n"), 1)


if __name__ == "__main__":
    unittest.main()
