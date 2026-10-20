#!/usr/bin/env python3
"""Release risk class of a change (#24, H3). Python 3 standard library only.

A change is `high` risk when any changed path matches one of RULES (auth, keys, users, crypto, the
HTTP and MCP surfaces and the SSRF guard of the gateway; NetworkPolicies, values, RBAC and Secrets
in the chart; the CI pipeline itself), otherwise `low`. A high-risk release is not promoted
automatically: scripts/canary/ci.sh records PROMOTE_PENDING_APPROVAL and the pipeline waits at the
manual `release:human-approval` job (.gitlab/ci/canary.gitlab-ci.yml). The same rules are stated in
the risk-gate flow (.gitlab/flows/risk-gate.yaml) and in that job's MR `rules:changes`;
.gitlab/flows/tests/flows.test.sh fails if the three drift.

Changed paths come from `git diff --name-only --no-renames` (a rename counts as both paths)
between a base and HEAD. The base is, in order: --base; CI_MERGE_REQUEST_DIFF_BASE_SHA (MR
pipelines: the merge base); CI_COMMIT_BEFORE_SHA (push pipelines on a branch: the previous tip);
HEAD~1 (pipelines without a push range: "Run pipeline", schedules, a new branch). If the diff
cannot be computed the change is `high` (fail closed). --paths-from reads the paths instead.

Output: risk.json {risk, reasons[], matches[], files_changed, base, base_source, head, rules[]}
and a dotenv file (RISK=high|low, RISK_MATCHED=<n>, RISK_PATHS=<a,b,...>) for GitLab CI. Paths in
the dotenv file are reduced to [A-Za-z0-9._/@+-] so a crafted file name cannot inject variables.
Exit 0 for either class; 2 on usage errors.

  scripts/canary/risk.py --out risk.json --env risk.env
  git diff --name-only main | scripts/canary/risk.py --paths-from -
  scripts/canary/risk.py --list-globs
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# (glob, why). `*` and `?` stay within one path segment; `**/` is zero or more directories. The
# globs are written so GitLab `rules:changes` reads them the same way.
RULES: list[tuple[str, str]] = [
    ("apps/gateway/src/auth/**/*", "gateway authentication"),
    ("apps/gateway/src/keys/**/*", "API key issue/verify/revoke"),
    ("apps/gateway/src/users/**/*", "users and roles"),
    ("apps/gateway/src/crypto/**/*", "upstream credential encryption"),
    ("apps/gateway/src/http/**/*", "gateway HTTP surface"),
    ("apps/gateway/src/mcp/**/*", "gateway MCP endpoint"),
    ("apps/gateway/src/upstreams/ssrf*", "SSRF guard for upstream URLs"),
    ("charts/**/networkpolicy*.yaml", "Kubernetes NetworkPolicy"),
    ("charts/**/values*.yaml", "Helm values (images, exposure, secrets wiring)"),
    ("charts/**/rbac*", "Kubernetes RBAC"),
    ("charts/**/secret*", "Kubernetes Secrets"),
    (".gitlab-ci.yml", "CI pipeline definition"),
    (".gitlab/ci/**/*", "CI pipeline definition"),
]

ZERO_SHA = "0" * 40
MAX_ENV_PATHS = 10
MAX_ENV_VALUE = 900
EXIT_USAGE = 2


def glob_re(glob: str) -> re.Pattern[str]:
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(f"^{out}$")


COMPILED = [(glob, why, glob_re(glob)) for glob, why in RULES]


def classify(paths: list[str]) -> dict:
    """{risk, reasons, matches, files_changed} for a list of repo-relative paths."""
    files = sorted({p.strip().removeprefix("./") for p in paths if p.strip()})
    matches = []
    for path in files:
        for glob, why, rx in COMPILED:
            if rx.match(path):
                matches.append({"path": path, "glob": glob, "why": why})
                break
    return {
        "risk": "high" if matches else "low",
        "reasons": [f"{m['path']}: {m['why']} ({m['glob']})" for m in matches]
        or [f"no high-risk paths among {len(files)} changed file(s)"],
        "matches": matches,
        "files_changed": len(files),
    }


def fail_closed(why: str) -> dict:
    return {
        "risk": "high",
        "reasons": [f"fail closed: {why}"],
        "matches": [],
        "files_changed": None,
    }


def resolve_base(env: dict) -> tuple[str, str]:
    """(git revision, where it came from) for the diff base."""
    if env.get("CI_MERGE_REQUEST_DIFF_BASE_SHA"):
        return env["CI_MERGE_REQUEST_DIFF_BASE_SHA"], "merge request diff base"
    before = env.get("CI_COMMIT_BEFORE_SHA", "")
    if before and before != ZERO_SHA:
        return before, "previous branch tip (push)"
    return "HEAD~1", "parent commit (no push range)"


def git_changed(base: str, head: str, cwd: str | None = None) -> list[str]:
    """Changed paths base..head. Raises RuntimeError with git's first error line."""
    res = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, head, "--"],
        cwd=cwd,
        capture_output=True,
        timeout=60,
    )
    if res.returncode != 0:
        err = res.stderr.decode(errors="replace").strip().splitlines()
        raise RuntimeError(f"git diff {base} {head}: {err[0] if err else 'failed'}")
    return [p for p in res.stdout.decode(errors="replace").split("\0") if p]


def env_safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._/@+-]", "_", text)


def dotenv(result: dict) -> str:
    paths = [env_safe(m["path"]) for m in result["matches"]]
    shown = ",".join(paths[:MAX_ENV_PATHS])
    if len(paths) > MAX_ENV_PATHS:
        shown += f",+{len(paths) - MAX_ENV_PATHS}_more"
    return (
        f"RISK={result['risk']}\n"
        f"RISK_MATCHED={len(result['matches'])}\n"
        f"RISK_PATHS={shown[:MAX_ENV_VALUE]}\n"
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--base", help="diff base revision (default: from CI env, else HEAD~1)")
    ap.add_argument("--head", default="HEAD", help="diff head revision (default HEAD)")
    ap.add_argument("--paths-from", help="read changed paths, one per line, from FILE ('-' = stdin)")
    ap.add_argument("--out", default="risk.json", help="JSON result (default risk.json)")
    ap.add_argument("--env", help="also write a dotenv file (RISK=..., for GitLab CI)")
    ap.add_argument("--list-globs", action="store_true", help="print the high-risk globs and exit")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as e:
        return 0 if e.code == 0 else EXIT_USAGE
    env = dict(os.environ) if env is None else env
    if args.list_globs:
        print("\n".join(glob for glob, _ in RULES))
        return 0

    meta: dict = {"head": args.head}
    if args.paths_from:
        try:
            if args.paths_from == "-":
                text = sys.stdin.read()
            else:
                with open(args.paths_from, encoding="utf-8") as f:
                    text = f.read()
        except OSError as e:
            print(f"risk.py: cannot read {args.paths_from}: {e.strerror}", file=sys.stderr)
            return EXIT_USAGE
        result = classify(text.splitlines())
        meta.update(base=None, base_source=f"paths from {args.paths_from}")
    else:
        base, source = (args.base, "--base") if args.base else resolve_base(env)
        meta.update(base=base, base_source=source)
        try:
            result = classify(git_changed(base, args.head))
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
            result = fail_closed(f"could not compute the change ({e})")

    out = {**result, **meta, "rules": [glob for glob, _ in RULES]}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    if args.env:
        with open(args.env, "w", encoding="utf-8") as f:
            f.write(dotenv(result))

    print(f"RISK: {result['risk']} (base {meta['base'] or '-'}: {meta['base_source']})")
    for reason in result["reasons"]:
        print(f"  - {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
