#!/usr/bin/env python3
"""The manual `release:human-approval` job (#24, H3). Python 3 standard library only.

A person clicks the job; this script records who approved what and when. It reads GitLab CI env:
  RISK, RISK_PATHS    dotenv from risk:classify (scripts/canary/risk.py)
  DECISION, VERDICT   dotenv from canary (scripts/canary/ci.sh); absent on MR pipelines, where the
                      approval is for merging (the canary there is optional and manual)
  GITLAB_USER_LOGIN   in a manual job: the user who started it
  CI_*                pipeline, job, commit and MR links

  RISK=low                                   nothing to approve: "low risk: no approval needed"
  RISK=high (or missing: fail closed)
    DECISION=PROMOTE_PENDING_APPROVAL        approve the promotion  -> DECISION=PROMOTE_APPROVED
    no DECISION (MR pipeline)                approve the merge      -> DECISION=MERGE_APPROVED
    any other DECISION                       exit 1: nothing to approve
    no GITLAB_USER_LOGIN                     exit 1: an approval needs a person

The job is created on every default-branch pipeline (a dotenv value can't decide whether a job
exists) and on MR pipelines whose diff touches a high-risk path, so a low-risk run is a click that
records "not required". The CI cluster is ephemeral: the approval is the release decision and its
record (approval.json artifact), not a deploy to a long-lived environment.

  scripts/canary/approval.py --out approval.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

PENDING = "PROMOTE_PENDING_APPROVAL"


def decide(env: dict) -> tuple[int, dict, str]:
    """(exit code, approval record, message) from CI env."""
    risk = env.get("RISK") or ""
    decision = env.get("DECISION") or ""
    record = {
        "required": True,
        "approved": False,
        "risk": risk or None,
        "risk_paths": [p for p in (env.get("RISK_PATHS") or "").split(",") if p],
        "canary_verdict": env.get("VERDICT") or None,
        "canary_decision": decision or None,
        "decision": None,
        "approved_by": None,
        "approved_at": None,
        "commit_sha": env.get("CI_COMMIT_SHA") or None,
        "ref": env.get("CI_COMMIT_REF_NAME") or None,
        "merge_request_iid": env.get("CI_MERGE_REQUEST_IID") or None,
        "pipeline_url": env.get("CI_PIPELINE_URL") or None,
        "job_url": env.get("CI_JOB_URL") or None,
    }
    if risk == "low":
        record.update(required=False, decision=decision or None)
        return 0, record, "low risk: no approval needed"
    if risk != "high":
        record["risk"] = "high"
        note = "RISK missing (risk:classify artifacts not found): treated as high. "
    else:
        note = ""
    if decision and decision != PENDING:
        return 1, record, f"{note}nothing to approve: canary decision is {decision}, not {PENDING}"
    login = env.get("GITLAB_USER_LOGIN") or ""
    if not login:
        return 1, record, f"{note}no GITLAB_USER_LOGIN: an approval needs a person"
    scope = "promotion" if decision else "merge"
    record.update(
        approved=True,
        decision="PROMOTE_APPROVED" if decision else "MERGE_APPROVED",
        approved_by=login,
        approved_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    paths = ", ".join(record["risk_paths"]) or "unknown paths"
    return 0, record, f"{note}APPROVED by @{login}: {scope} of high-risk change ({paths})"


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--out", default="approval.json", help="approval record (default approval.json)")
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    code, record, message = decide(dict(os.environ) if env is None else env)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)
        f.write("\n")
    print(message, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
