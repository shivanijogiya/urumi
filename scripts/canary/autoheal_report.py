#!/usr/bin/env python3
"""The `autoheal:report` CI job (#28; docs/adr/005-self-healing.md). Python 3 standard library only.

The postmortem flow (.gitlab/flows/postmortem.yaml) must read the canary verdict of an autoheal
merge request's pipeline. A Duo flow can read a job log with get_logs_from_job, but the only job
lookup in the tools list we use is get_pipeline_failing_jobs, which returns FAILED jobs only, and a
verified fix has a successful canary. So this job, which runs after `canary` on autoheal MR
pipelines (allow_failure: true), prints the canary's verdict.json as one line

    AUTOHEAL_VERDICT_JSON: {...}

and then exits 1 on purpose: the job is listed by get_pipeline_failing_jobs, its log carries the
verdict, and allow_failure keeps the pipeline green. When the canary left no verdict.json (setup
failure), the line says {"decision": "NONE", ...}.

  scripts/canary/autoheal_report.py [--verdict verdict.json]     always exits 1
"""

from __future__ import annotations

import argparse
import json
import sys

MARKER = "AUTOHEAL_VERDICT_JSON: "
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


def summary(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"decision": "NONE", "reason": "the canary job left no readable verdict.json"}
    if not isinstance(data, dict) or not isinstance(data.get("decision"), str):
        return {"decision": "NONE", "reason": "verdict.json has no decision"}
    return {k: data[k] for k in KEEP if k in data}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--verdict", default="verdict.json")
    a = p.parse_args(argv)
    s = summary(a.verdict)
    print(f"autoheal canary decision: {s['decision']}")
    print(MARKER + json.dumps(s, separators=(",", ":"), sort_keys=True))
    print(
        "autoheal:report fails on purpose (allow_failure): get_pipeline_failing_jobs is how the "
        "postmortem flow finds this log. The canary job's own status is the verification.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
