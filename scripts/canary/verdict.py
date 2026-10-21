#!/usr/bin/env python3
"""Canary verdict for the gateway (#23, H2). Python 3 standard library only.

Sends MCP `tools/call woo__list_orders` requests through the app Ingress with a member's API key,
tags each response by the Deployment that served it (`x-urumi-track: stable|canary`, set by the
gateway from TRACK), and compares the canary with the stable gateway on:
  - error rate       share of requests without a 2xx answer (5xx, 4xx, timeout, connection error)
  - p95 latency      nearest-rank 95th percentile, milliseconds
  - success          share of requests whose woo__list_orders result is a non-error tool result

Verdict (exit code):
  PROMOTE  (0)  every check passes
  ROLLBACK (1)  canary error rate > --max-error-rate, or > stable + --max-error-delta;
                canary p95 > --latency-factor x stable p95 + --latency-slack-ms;
                canary success < --min-success;
                failures without an x-urumi-track header (no answer, proxy 502/503 from a dead
                canary pod) > --max-error-rate of all requests while stable is healthy
  HOLD     (2)  not enough evidence: a track served fewer than --min-samples requests, or the
                stable gateway itself fails the error-rate/success thresholds
  (3)           usage error: bad flags, no API key

Sending: --requests (default 60) requests, --concurrency at a time; if the canary has served fewer
than --min-samples by then, more are sent in batches up to --max-requests.

AI shoppers (#29, docs/adr/006-ai-shoppers.md), an extra signal on top of the rules above:
--shoppers shoppers.json (scripts/canary/shoppers.py) turns the verdict into ROLLBACK when the
canary's shopper success rate is below stable's minus --shopper-max-drop (default 0.25) with at
least --shopper-min-journeys (default 3) valid canary journeys; the reason quotes the most common
canary blocker (model output: sanitized, at most 160 characters). Ignored, and said so in reasons,
when stable shoppers succeed less than --shopper-min-stable (default 0.5): an environment problem.
Ignored silently when the shoppers were skipped (no Anthropic key, API down). --report verdict.json
applies the shoppers to an existing report instead of probing (ci.sh runs both concurrently).

Output: one JSON object {verdict, reasons[], stable{...}, canary{...}, samples{...}, thresholds,
...} on stdout and in --out (default verdict.json). The API key comes from --key-file or the
CANARY_API_KEY env var and is never printed or written.

  scripts/canary/verdict.py --key-file tests/e2e/.out/userb2.key
  scripts/canary/verdict.py --samples-file samples.json   # decide from recorded samples (offline)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass

TRACK_HEADER = "x-urumi-track"
TRACKS = ("stable", "canary")
EXIT = {"PROMOTE": 0, "ROLLBACK": 1, "HOLD": 2}
EXIT_USAGE = 3
EPS = 1e-9


@dataclass
class Sample:
    """One request: which track answered, how, and how long it took."""

    track: str  # stable | canary | unknown (no x-urumi-track header, or no answer)
    status: int | None  # HTTP status; None = timeout or connection error
    tool_ok: bool  # 2xx with a JSON-RPC result that is not a tool error
    latency_ms: float
    error: str = ""  # short reason when not tool_ok (never response content or the key)

    @property
    def http_error(self) -> bool:
        return self.status is None or not 200 <= self.status < 300


@dataclass
class Thresholds:
    max_error_rate: float = 0.10
    max_error_delta: float = 0.05
    latency_factor: float = 1.5
    latency_slack_ms: float = 200.0
    min_success: float = 0.95
    min_samples: int = 10


@dataclass
class ShopperThresholds:
    max_drop: float = 0.25
    min_journeys: int = 3
    min_stable: float = 0.5


# ── Classification ──────────────────────────────────────────────────────────────────────────────


def parse_rpc_body(body: bytes, content_type: str) -> dict | None:
    """The JSON-RPC response in a JSON or an SSE (text/event-stream) body; None if there is none."""
    text = body.decode("utf-8", "replace")
    candidates = []
    if "text/event-stream" in content_type:
        for line in text.splitlines():
            if line.startswith("data:"):
                candidates.append(line[5:].strip())
    else:
        candidates.append(text)
    for raw in candidates:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if isinstance(msg, dict) and ("result" in msg or "error" in msg):
            return msg
    return None


def classify(status: int | None, headers: dict, body: bytes, latency_ms: float) -> Sample:
    """A Sample from one HTTP exchange. `headers` keys are lower-case."""
    track = headers.get(TRACK_HEADER, "").strip().lower() or "unknown"
    if status is None:
        return Sample("unknown", None, False, latency_ms, "no answer")
    if not 200 <= status < 300:
        return Sample(track, status, False, latency_ms, f"HTTP {status}")
    msg = parse_rpc_body(body, headers.get("content-type", ""))
    if msg is None:
        return Sample(track, status, False, latency_ms, "no JSON-RPC response")
    if "error" in msg:
        return Sample(track, status, False, latency_ms, "JSON-RPC error")
    result = msg.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        return Sample(track, status, False, latency_ms, "tool error")
    return Sample(track, status, True, latency_ms)


# ── Statistics and the decision ────────────────────────────────────────────────────────────────


def p95(values: list[float]) -> float | None:
    """Nearest-rank 95th percentile."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def summarize(samples: list[Sample]) -> dict:
    n = len(samples)
    errors = sum(1 for s in samples if s.http_error)
    ok = sum(1 for s in samples if s.tool_ok)
    latencies = [s.latency_ms for s in samples]
    p = p95(latencies)
    return {
        "n": n,
        "errors": errors,
        "error_rate": round(errors / n, 4) if n else None,
        "tool_ok": ok,
        "success_rate": round(ok / n, 4) if n else None,
        "p50_ms": round(sorted(latencies)[(n - 1) // 2], 1) if n else None,
        "p95_ms": round(p, 1) if p is not None else None,
    }


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def decide(
    stable: dict, canary: dict, th: Thresholds, unattributed_errors: int = 0, total: int = 0
) -> tuple[str, list[str]]:
    """PROMOTE | ROLLBACK | HOLD and the reasons, from two summarize() results.

    `unattributed_errors`: failed requests without an x-urumi-track header (no answer, or a proxy
    error such as a 502 from a dead canary pod) out of `total` requests. With a healthy stable they
    are blamed on the canary: more than --max-error-rate of all requests means ROLLBACK.
    """
    hold = []
    for name, s in (("canary", canary), ("stable", stable)):
        if s["n"] < th.min_samples:
            hold.append(f"{name} served only {s['n']} requests (< {th.min_samples}): not enough data")
    if not hold:
        if stable["error_rate"] > th.max_error_rate + EPS:
            hold.append(
                f"stable itself is unhealthy: error rate {pct(stable['error_rate'])} > {pct(th.max_error_rate)}"
            )
        if stable["success_rate"] + EPS < th.min_success:
            hold.append(
                f"stable itself is unhealthy: woo__list_orders success {pct(stable['success_rate'])} < {pct(th.min_success)}"
            )
    if hold:
        return "HOLD", hold

    bad, good = [], []
    err_limit = min(th.max_error_rate, stable["error_rate"] + th.max_error_delta)
    msg = (
        f"canary error rate {pct(canary['error_rate'])} vs limit {pct(err_limit)} "
        f"(stable {pct(stable['error_rate'])} + {pct(th.max_error_delta)}, at most {pct(th.max_error_rate)})"
    )
    (bad if canary["error_rate"] > err_limit + EPS else good).append(msg)

    lat_limit = th.latency_factor * stable["p95_ms"] + th.latency_slack_ms
    msg = (
        f"canary p95 {canary['p95_ms']:.0f} ms vs limit {lat_limit:.0f} ms "
        f"({th.latency_factor:g} x stable p95 {stable['p95_ms']:.0f} ms + {th.latency_slack_ms:.0f} ms)"
    )
    (bad if canary["p95_ms"] > lat_limit + EPS else good).append(msg)

    if total:
        share = unattributed_errors / total
        msg = (
            f"{unattributed_errors} of {total} requests failed without an {TRACK_HEADER} header "
            f"({pct(share)} vs limit {pct(th.max_error_rate)}; stable is healthy, so blamed on the canary)"
        )
        if share > th.max_error_rate + EPS:
            bad.append(msg)
        elif unattributed_errors:
            good.append(msg)

    msg = f"canary woo__list_orders success {pct(canary['success_rate'])} vs minimum {pct(th.min_success)}"
    (bad if canary["success_rate"] + EPS < th.min_success else good).append(msg)

    if bad:
        return "ROLLBACK", bad
    return "PROMOTE", good


def report(samples: list[Sample], th: Thresholds, extra: dict | None = None) -> dict:
    by_track = {t: [s for s in samples if s.track == t] for t in TRACKS}
    stable, canary = summarize(by_track["stable"]), summarize(by_track["canary"])
    unknown = [s for s in samples if s.track not in TRACKS]
    unattributed = sum(1 for s in unknown if s.http_error)
    verdict, reasons = decide(stable, canary, th, unattributed, len(samples))
    out = {
        "verdict": verdict,
        "reasons": reasons,
        "stable": stable,
        "canary": canary,
        "samples": {
            "total": len(samples),
            "stable": stable["n"],
            "canary": canary["n"],
            "unknown": len(unknown),
            "unattributed_errors": unattributed,
        },
        "thresholds": asdict(th),
    }
    if extra:
        out.update(extra)
    return out


# ── AI shoppers (#29) ──────────────────────────────────────────────────────────────────────────

QUOTE_MAX = 160
_URL = re.compile(r"(?i)\b(?:[a-z][a-z0-9+.-]*://|www\.)\S*")


def sanitize_quote(text: object, limit: int = QUOTE_MAX) -> str:
    """Model output made safe to quote in a log, an issue or a flow prompt: no control or format
    characters, URLs, backticks, @mentions or Markdown table/HTML characters; one line; at most
    `limit` characters."""
    if not isinstance(text, str):
        return ""
    s = "".join(" " if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") else ch for ch in text)
    s = _URL.sub("", s)
    s = re.sub(r"[`@<>|\\]", "", s)
    s = " ".join(s.split())
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def load_shoppers(path: str) -> dict:
    """shoppers.py's output, or {"skipped": reason} when there is none to use."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"skipped": "no readable shoppers.json"}
    if not isinstance(data, dict):
        return {"skipped": "shoppers.json is not an object"}
    if not data.get("skipped") and not isinstance(data.get("tracks"), dict):
        return {"skipped": "shoppers.json has no tracks"}
    return data


def _track_counts(t: object) -> dict:
    t = t if isinstance(t, dict) else {}
    valid, completed = t.get("valid"), t.get("completed")
    valid = valid if isinstance(valid, int) and valid >= 0 else 0
    completed = completed if isinstance(completed, int) and 0 <= completed <= valid else 0
    rate = round(completed / valid, 4) if valid else None
    return {"valid": valid, "completed": completed, "invalid": t.get("invalid"), "success_rate": rate}


def customer_voice(blockers: object) -> str | None:
    """The most common canary blocker (first seen wins a tie), sanitized; None if there is none."""
    quotes = [sanitize_quote(b) for b in blockers if isinstance(b, str)] if isinstance(blockers, list) else []
    quotes = [q for q in quotes if q]
    if not quotes:
        return None
    counts = Counter(quotes)
    return max(quotes, key=lambda q: (counts[q], -quotes.index(q)))


def apply_shoppers(out: dict, shoppers: dict, sth: ShopperThresholds) -> dict:
    """The report with the shopper rule applied (an extra ROLLBACK reason, never a PROMOTE).
    Starts from the probe's own verdict (probe_verdict/probe_reasons), so applying twice is the
    same as applying once."""
    out = dict(out)
    verdict = out.setdefault("probe_verdict", out["verdict"])
    reasons = list(out.setdefault("probe_reasons", list(out["reasons"])))
    block: dict = {"thresholds": asdict(sth)}
    for k in ("model", "spent_usd"):
        if k in shoppers:
            block[k] = shoppers[k]
    voice = None
    if shoppers.get("skipped"):
        block.update(status="skipped", note=sanitize_quote(shoppers["skipped"], 200))
    else:
        tracks = shoppers["tracks"]
        st, ca = _track_counts(tracks.get("stable")), _track_counts(tracks.get("canary"))
        block.update(stable=st, canary=ca)
        tally = (
            f"{ca['completed']}/{ca['valid']} journeys completed on canary vs "
            f"{st['completed']}/{st['valid']} on stable"
        )
        if st["valid"] == 0 or st["success_rate"] + EPS < sth.min_stable:
            note = (
                f"AI shoppers ignored: only {st['completed']}/{st['valid']} journeys completed on "
                f"stable (< {pct(sth.min_stable)}): an environment problem, not the canary"
            )
            block.update(status="ignored", note=note)
            reasons.append(note)
        elif ca["valid"] < sth.min_journeys:
            note = f"AI shoppers ignored: only {ca['valid']} valid canary journeys (< {sth.min_journeys})"
            block.update(status="ignored", note=note)
            reasons.append(note)
        else:
            block["status"] = "used"
            voice = customer_voice((tracks.get("canary") or {}).get("blockers"))
            if ca["success_rate"] + EPS < st["success_rate"] - sth.max_drop:
                quote = f' — "{voice}"' if voice else ""
                msg = f"AI shoppers: {tally}{quote}"
                block["rollback"] = True
                if verdict == "PROMOTE":
                    verdict, reasons = "ROLLBACK", [msg]
                else:
                    reasons.append(msg)
            else:
                block["rollback"] = False
                if verdict == "PROMOTE":  # a passing check is a reason only for a PROMOTE
                    limit = f"rollback below stable - {sth.max_drop * 100:g} points"
                    reasons.append(f"AI shoppers: {tally} ({limit})")
    block["customer_voice"] = voice
    out.update(verdict=verdict, reasons=reasons, shoppers=block, customer_voice=voice)
    return out


# ── Sending ────────────────────────────────────────────────────────────────────────────────────


def call_once(url: str, key: str, tool: str, args: dict, timeout: float, req_id: int) -> Sample:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": tool, "arguments": args},
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            "authorization": f"Bearer {key}",
        },
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = res.read()
            ms = (time.monotonic() - start) * 1000
            headers = {k.lower(): v for k, v in res.headers.items()}
            return classify(res.status, headers, data, ms)
    except urllib.error.HTTPError as err:
        data = err.read()
        ms = (time.monotonic() - start) * 1000
        headers = {k.lower(): v for k, v in (err.headers or {}).items()}
        return classify(err.code, headers, data, ms)
    except (urllib.error.URLError, TimeoutError, OSError):
        return classify(None, {}, b"", (time.monotonic() - start) * 1000)


def probe(
    url: str,
    key: str,
    tool: str,
    args: dict,
    *,
    requests: int,
    max_requests: int,
    min_canary: int,
    concurrency: int,
    timeout: float,
) -> list[Sample]:
    samples: list[Sample] = []

    def batch(n: int) -> None:
        start = len(samples)
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [
                pool.submit(call_once, url, key, tool, args, timeout, start + i + 1) for i in range(n)
            ]
            samples.extend(f.result() for f in futures)

    batch(requests)
    while len(samples) < max_requests and sum(s.track == "canary" for s in samples) < min_canary:
        batch(min(max(10, concurrency), max_requests - len(samples)))
    return samples


# ── CLI ────────────────────────────────────────────────────────────────────────────────────────


class Parser(argparse.ArgumentParser):
    def error(self, message: str):  # exit 3, not argparse's 2 (2 is HOLD)
        self.print_usage(sys.stderr)
        print(f"verdict.py: error: {message}", file=sys.stderr)
        sys.exit(EXIT_USAGE)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = Parser(description="Canary verdict: PROMOTE (0) / ROLLBACK (1) / HOLD (2).")
    p.add_argument("--url", default=os.environ.get("MCP_URL", "http://app.localtest.me/mcp"))
    p.add_argument("--key-file", help="file holding the API key (else env CANARY_API_KEY)")
    p.add_argument("--tool", default="woo__list_orders")
    p.add_argument("--args", default='{"date": "today"}', help="tool arguments (JSON object)")
    p.add_argument("--requests", type=int, default=60)
    p.add_argument("--max-requests", type=int, help="default 4 x --requests")
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--timeout", type=float, default=20.0, help="per request, seconds")
    p.add_argument("--max-error-rate", type=float, default=Thresholds.max_error_rate)
    p.add_argument("--max-error-delta", type=float, default=Thresholds.max_error_delta)
    p.add_argument("--latency-factor", type=float, default=Thresholds.latency_factor)
    p.add_argument("--latency-slack-ms", type=float, default=Thresholds.latency_slack_ms)
    p.add_argument("--min-success", type=float, default=Thresholds.min_success)
    p.add_argument("--min-samples", type=int, default=Thresholds.min_samples)
    p.add_argument("--out", default="verdict.json", help="'' = do not write a file")
    p.add_argument("--samples-file", help="decide from recorded samples (JSON list) instead")
    p.add_argument("--report", help="start from this verdict.py report instead of probing")
    p.add_argument("--shoppers", help="shoppers.json from scripts/canary/shoppers.py (#29)")
    p.add_argument("--shopper-max-drop", type=float, default=ShopperThresholds.max_drop)
    p.add_argument("--shopper-min-journeys", type=int, default=ShopperThresholds.min_journeys)
    p.add_argument("--shopper-min-stable", type=float, default=ShopperThresholds.min_stable)
    a = p.parse_args(argv)
    if a.report and a.samples_file:
        p.error("--report and --samples-file are exclusive")
    if a.shopper_min_journeys < 1 or not 0 <= a.shopper_max_drop <= 1:
        p.error("--shopper-min-journeys must be >= 1 and --shopper-max-drop 0..1")
    if a.requests < 1 or a.concurrency < 1 or a.min_samples < 1:
        p.error("--requests, --concurrency and --min-samples must be >= 1")
    if a.max_requests is None:
        a.max_requests = 4 * a.requests
    if a.max_requests < a.requests:
        p.error("--max-requests must be >= --requests")
    try:
        a.args = json.loads(a.args)
    except ValueError:
        p.error("--args is not JSON")
    if not isinstance(a.args, dict):
        p.error("--args must be a JSON object")
    return a


def read_key(key_file: str | None) -> str | None:
    if key_file:
        try:
            with open(key_file, encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError:
            return None
    return os.environ.get("CANARY_API_KEY", "").strip() or None


def load_samples(path: str) -> list[Sample]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return [
        Sample(
            track=r["track"],
            status=r.get("status"),
            tool_ok=bool(r["tool_ok"]),
            latency_ms=float(r["latency_ms"]),
            error=r.get("error", ""),
        )
        for r in raw
    ]


def main(argv: list[str] | None = None) -> int:
    a = parse_args(sys.argv[1:] if argv is None else argv)
    th = Thresholds(
        max_error_rate=a.max_error_rate,
        max_error_delta=a.max_error_delta,
        latency_factor=a.latency_factor,
        latency_slack_ms=a.latency_slack_ms,
        min_success=a.min_success,
        min_samples=a.min_samples,
    )
    out = None
    if a.report:
        try:
            with open(a.report, encoding="utf-8") as f:
                out = json.load(f)
        except (OSError, ValueError):
            out = None
        if not isinstance(out, dict) or out.get("verdict") not in EXIT:
            print(f"verdict.py: error: {a.report} is not a verdict.py report", file=sys.stderr)
            return EXIT_USAGE
    elif a.samples_file:
        samples = load_samples(a.samples_file)
        extra = {"source": "samples-file"}
    else:
        key = read_key(a.key_file)
        if not key:
            print("verdict.py: error: no API key (--key-file or CANARY_API_KEY)", file=sys.stderr)
            return EXIT_USAGE
        started = time.monotonic()
        samples = probe(
            a.url,
            key,
            a.tool,
            a.args,
            requests=a.requests,
            max_requests=a.max_requests,
            min_canary=a.min_samples,
            concurrency=a.concurrency,
            timeout=a.timeout,
        )
        extra = {
            "url": a.url,
            "tool": a.tool,
            "duration_s": round(time.monotonic() - started, 1),
            "errors_seen": sorted({s.error for s in samples if s.error}),
        }
    if out is None:
        out = report(samples, th, extra)
    if a.shoppers:
        sth = ShopperThresholds(
            max_drop=a.shopper_max_drop,
            min_journeys=a.shopper_min_journeys,
            min_stable=a.shopper_min_stable,
        )
        out = apply_shoppers(out, load_shoppers(a.shoppers), sth)
    text = json.dumps(out, indent=2)
    print(text)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    print(f"VERDICT: {out['verdict']}", file=sys.stderr)
    return EXIT[out["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
