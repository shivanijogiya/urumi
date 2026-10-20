"""Unit tests for risk.py and approval.py (#24, H3). Standard library only:
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'

Classification tests use path lists; the diff tests run risk.py's real `git diff` against a
throwaway git repository. Nothing under test is mocked.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import approval  # noqa: E402
import risk  # noqa: E402


def quiet(fn, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*args, **kwargs)


class Classify(unittest.TestCase):
    def assertRisk(self, paths: list[str], expected: str):
        self.assertEqual(risk.classify(paths)["risk"], expected, paths)

    def test_gateway_auth_change_is_high(self):
        r = risk.classify(["apps/gateway/src/auth/session.ts", "README.md"])
        self.assertEqual(r["risk"], "high")
        self.assertEqual([m["path"] for m in r["matches"]], ["apps/gateway/src/auth/session.ts"])
        self.assertIn("apps/gateway/src/auth/session.ts: gateway authentication", r["reasons"][0])

    def test_docs_only_change_is_low(self):
        r = risk.classify(["docs/HACKATHON.md", "README.md", "docs/adr/004-duo-flows.md"])
        self.assertEqual(r["risk"], "low")
        self.assertEqual(r["matches"], [])
        self.assertEqual(r["files_changed"], 3)

    def test_values_file_is_high(self):
        self.assertRisk(["charts/platform/values.yaml"], "high")
        self.assertRisk(["charts/platform/values-prod.yaml"], "high")
        self.assertRisk(["charts/platform/values-local.yaml"], "high")

    def test_every_gateway_security_area_is_high(self):
        for area in ("auth", "keys", "users", "crypto", "http", "mcp"):
            self.assertRisk([f"apps/gateway/src/{area}/x.ts"], "high")
            self.assertRisk([f"apps/gateway/src/{area}/deep/er/x.ts"], "high")

    def test_ssrf_guard_is_high_other_upstream_code_is_low(self):
        self.assertRisk(["apps/gateway/src/upstreams/ssrf.ts"], "high")
        self.assertRisk(["apps/gateway/src/upstreams/ssrf.test.ts"], "high")
        self.assertRisk(["apps/gateway/src/upstreams/repo.ts"], "low")

    def test_chart_security_objects_are_high(self):
        self.assertRisk(["charts/platform/templates/postgres/networkpolicy.yaml"], "high")
        self.assertRisk(["charts/platform/templates/bootstrap/rbac.yaml"], "high")
        self.assertRisk(["charts/platform/templates/gateway/secret.yaml"], "high")
        self.assertRisk(["charts/platform/templates/gateway/deployment.yaml"], "low")
        self.assertRisk(["charts/platform/Chart.yaml"], "low")

    def test_ci_definition_is_high(self):
        self.assertRisk([".gitlab-ci.yml"], "high")
        self.assertRisk([".gitlab/ci/canary.gitlab-ci.yml"], "high")
        self.assertRisk([".gitlab/ci/tests/release-config.test.sh"], "high")

    def test_near_misses_are_low(self):
        self.assertRisk(["apps/gateway/src/authz/x.ts"], "low")  # not auth/
        self.assertRisk(["apps/gateway/src/chat/agent.ts"], "low")
        self.assertRisk(["apps/gateway/test/auth/session.test.ts"], "low")  # tests, not src
        self.assertRisk(["apps/dashboard/src/auth/login.tsx"], "low")  # dashboard, not gateway
        self.assertRisk(["docs/values.yaml"], "low")  # not under charts/
        self.assertRisk([".gitlab/flows/incident.yaml"], "low")

    def test_empty_change_is_low_and_says_so(self):
        r = risk.classify(["", "  "])
        self.assertEqual((r["risk"], r["files_changed"]), ("low", 0))
        self.assertIn("0 changed file(s)", r["reasons"][0])

    def test_globs_cover_the_issue_rules_in_order(self):
        self.assertEqual(
            [g for g, _ in risk.RULES],
            [
                "apps/gateway/src/auth/**/*",
                "apps/gateway/src/keys/**/*",
                "apps/gateway/src/users/**/*",
                "apps/gateway/src/crypto/**/*",
                "apps/gateway/src/http/**/*",
                "apps/gateway/src/mcp/**/*",
                "apps/gateway/src/upstreams/ssrf*",
                "charts/**/networkpolicy*.yaml",
                "charts/**/values*.yaml",
                "charts/**/rbac*",
                "charts/**/secret*",
                ".gitlab-ci.yml",
                ".gitlab/ci/**/*",
            ],
        )


class Base(unittest.TestCase):
    def test_mr_pipeline_uses_the_merge_base(self):
        env = {"CI_MERGE_REQUEST_DIFF_BASE_SHA": "abc", "CI_COMMIT_BEFORE_SHA": "def"}
        self.assertEqual(risk.resolve_base(env), ("abc", "merge request diff base"))

    def test_push_pipeline_uses_the_previous_tip(self):
        self.assertEqual(risk.resolve_base({"CI_COMMIT_BEFORE_SHA": "def"})[0], "def")

    def test_no_push_range_falls_back_to_the_parent(self):
        self.assertEqual(risk.resolve_base({"CI_COMMIT_BEFORE_SHA": "0" * 40})[0], "HEAD~1")
        self.assertEqual(risk.resolve_base({})[0], "HEAD~1")


class Dotenv(unittest.TestCase):
    def test_crafted_file_name_cannot_inject_variables(self):
        r = risk.classify(["charts/x/values\nDECISION=PROMOTE.yaml"])
        r = {**r, "matches": [{"path": "charts/x/values\nDECISION=PROMOTE.yaml"}]}
        text = risk.dotenv(r)
        self.assertEqual(len(text.splitlines()), 3)
        self.assertNotIn("\nDECISION=", text)
        self.assertIn("RISK_PATHS=charts/x/values_DECISION_PROMOTE.yaml", text)

    def test_long_lists_are_capped(self):
        r = risk.classify([f"apps/gateway/src/auth/f{i}.ts" for i in range(25)])
        line = [ln for ln in risk.dotenv(r).splitlines() if ln.startswith("RISK_PATHS=")][0]
        self.assertTrue(line.endswith(",+15_more"))
        self.assertIn("RISK_MATCHED=25", risk.dotenv(r))


@unittest.skipUnless(shutil.which("git"), "git not installed")
class GitDiff(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.git("init", "-q", "-b", "main")
        self.write("README.md", "hi\n")
        self.write("apps/gateway/src/auth/old.ts", "x\n")
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD")
        self.cwd = os.getcwd()
        os.chdir(self.dir)
        self.addCleanup(os.chdir, self.cwd)

    def git(self, *args: str) -> str:
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@example.invalid",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        }
        out = subprocess.run(
            ["git", *args], cwd=self.dir, env=env, capture_output=True, text=True, check=True
        )
        return out.stdout.strip()

    def write(self, path: str, text: str):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def commit(self, msg: str):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def run_risk(self, env: dict, *extra: str) -> dict:
        out, envf = os.path.join(self.dir, "risk.json"), os.path.join(self.dir, "risk.env")
        code = quiet(risk.main, ["--out", out, "--env", envf, *extra], env=env)
        self.assertEqual(code, 0)
        with open(out) as f:
            result = json.load(f)
        with open(envf) as f:
            result["_env"] = f.read()
        return result

    def test_docs_commit_on_main_is_low(self):
        self.write("docs/a.md", "doc\n")
        self.commit("docs")
        r = self.run_risk({"CI_COMMIT_BEFORE_SHA": self.base})
        self.assertEqual(r["risk"], "low")
        self.assertEqual((r["base"], r["files_changed"]), (self.base, 1))
        self.assertIn("RISK=low\n", r["_env"])

    def test_auth_change_in_an_mr_is_high_with_paths_in_dotenv(self):
        self.write("apps/gateway/src/auth/new.ts", "y\n")
        self.write("docs/a.md", "doc\n")
        self.commit("auth")
        r = self.run_risk({"CI_MERGE_REQUEST_DIFF_BASE_SHA": self.base})
        self.assertEqual(r["risk"], "high")
        self.assertEqual(r["base_source"], "merge request diff base")
        self.assertIn("RISK=high\nRISK_MATCHED=1\nRISK_PATHS=apps/gateway/src/auth/new.ts\n", r["_env"])

    def test_moving_a_file_out_of_a_high_risk_area_is_high(self):
        self.git("mv", "apps/gateway/src/auth/old.ts", "apps/gateway/src/old.ts")
        self.commit("move")
        r = self.run_risk({}, "--base", self.base)
        self.assertEqual(r["risk"], "high")
        self.assertEqual([m["path"] for m in r["matches"]], ["apps/gateway/src/auth/old.ts"])

    def test_web_pipeline_without_push_range_diffs_the_parent(self):
        self.write("charts/platform/values.yaml", "a: 1\n")
        self.commit("values")
        r = self.run_risk({"CI_COMMIT_BEFORE_SHA": "0" * 40})
        self.assertEqual((r["risk"], r["base"]), ("high", "HEAD~1"))

    def test_unknown_base_fails_closed(self):
        r = self.run_risk({"CI_MERGE_REQUEST_DIFF_BASE_SHA": "f" * 40})
        self.assertEqual(r["risk"], "high")
        self.assertTrue(r["reasons"][0].startswith("fail closed: could not compute the change"))
        self.assertIn("RISK=high\n", r["_env"])

    def test_list_globs(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(risk.main(["--list-globs"], env={}), 0)
        self.assertEqual(out.getvalue().splitlines(), [g for g, _ in risk.RULES])


class Approval(unittest.TestCase):
    MAIN = {
        "RISK": "high",
        "RISK_PATHS": "apps/gateway/src/auth/session.ts,charts/platform/values.yaml",
        "VERDICT": "PROMOTE",
        "DECISION": "PROMOTE_PENDING_APPROVAL",
        "GITLAB_USER_LOGIN": "aadi",
        "CI_COMMIT_SHA": "abc",
    }

    def test_low_risk_needs_no_approval(self):
        code, rec, msg = approval.decide({"RISK": "low", "DECISION": "PROMOTE"})
        self.assertEqual((code, rec["required"], rec["approved"]), (0, False, False))
        self.assertEqual(msg, "low risk: no approval needed")

    def test_high_risk_promotion_records_the_approver(self):
        code, rec, msg = approval.decide(self.MAIN)
        self.assertEqual(code, 0)
        self.assertEqual((rec["approved"], rec["approved_by"]), (True, "aadi"))
        self.assertEqual(rec["decision"], "PROMOTE_APPROVED")
        self.assertEqual(rec["risk_paths"][0], "apps/gateway/src/auth/session.ts")
        self.assertIsNotNone(rec["approved_at"])
        self.assertIn("APPROVED by @aadi: promotion", msg)

    def test_mr_pipeline_approves_the_merge(self):
        env = {k: v for k, v in self.MAIN.items() if k not in ("DECISION", "VERDICT")}
        code, rec, _ = approval.decide({**env, "CI_MERGE_REQUEST_IID": "7"})
        self.assertEqual((code, rec["decision"], rec["merge_request_iid"]), (0, "MERGE_APPROVED", "7"))

    def test_nothing_to_approve_after_a_rollback(self):
        code, rec, msg = approval.decide({**self.MAIN, "DECISION": "ROLLBACK"})
        self.assertEqual((code, rec["approved"]), (1, False))
        self.assertIn("nothing to approve", msg)

    def test_an_approval_needs_a_person(self):
        code, rec, _ = approval.decide({**self.MAIN, "GITLAB_USER_LOGIN": ""})
        self.assertEqual((code, rec["approved"]), (1, False))

    def test_missing_risk_fails_closed(self):
        env = {k: v for k, v in self.MAIN.items() if k != "RISK"}
        code, rec, msg = approval.decide(env)
        self.assertEqual((code, rec["risk"], rec["approved"]), (0, "high", True))
        self.assertIn("treated as high", msg)

    def test_main_writes_the_record(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "approval.json")
            self.assertEqual(quiet(approval.main, ["--out", out], env=self.MAIN), 0)
            with open(out) as f:
                self.assertEqual(json.load(f)["approved_by"], "aadi")


if __name__ == "__main__":
    unittest.main()
