"""Unit tests for shoppers.py (#29). Standard library only:
  python3 -m unittest discover -s scripts/canary -p 'test_*.py'

shoppers.py runs for real against one in-process HTTP server that plays the three external
boundaries: the Anthropic Messages API (a scripted, deterministic "shopper" that follows each
persona's plan and gives up with a customer sentence after a failed tool), the gateway's MCP
endpoint (x-urumi-track per the X-Urumi-Track pin, optional tool errors, wrong-track answers and
dead pods) and the WooCommerce Store API (cart, add-item, COD checkout). Nothing in shoppers.py is
mocked.
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
import shoppers  # noqa: E402

ANTHROPIC_KEY = "sk-ant-test-key-must-never-be-printed-91c3"
GATEWAY_KEY = "urk_gateway-key-must-never-be-printed-77d1"
SEEDED_ORDER = 100
PRODUCTS = [
    {"id": 7, "name": "Demo Tee", "price": "499", "stock_status": "instock"},
    {"id": 8, "name": "Brass Lamp", "price": "2500", "stock_status": "instock"},
]
ORDERS_BLOCKER = "I couldn't see the orders; the store showed an error."
OTHER_BLOCKER = "Something went wrong and the store showed an error."


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.model_mode = "honest"  # honest | liar | loop | down | notfound
        self.refuse_temperature = False  # newer models: 400 "temperature is deprecated"
        self.usage_in = 1000
        self.tool_errors: set[tuple[str, str]] = set()  # (pinned track, tool)
        self.answer_track: str | None = None  # answer with this track whatever the pin
        self.dead_track: str | None = None  # 502 without x-urumi-track on this pinned track
        self.orders: list[int] = []
        self.model_requests = 0
        self.model_bodies: list[dict] = []
        self.pins: list[tuple[str, str]] = []  # (pin header, answering track)
        self.bad_auth = 0


# ── The fake shopper (Anthropic Messages API) ───────────────────────────────────────────────────


def persona_of(system: str) -> str:
    for p in shoppers.PERSONAS:
        if p["goal"] in system:
            return p["id"]
    raise AssertionError("unknown persona")


def tool_use(i: int, name: str, args: dict) -> dict:
    return {"type": "tool_use", "id": f"tu_{i}_{name}", "name": name, "input": args}


def history(messages: list[dict]) -> list[tuple[str, bool, str]]:
    """[(tool name, is_error, result text)] in order."""
    names = {}
    out = []
    for m in messages:
        if not isinstance(m["content"], list):
            continue
        for b in m["content"]:
            if b.get("type") == "tool_use":
                names[b["id"]] = b["name"]
            elif b.get("type") == "tool_result":
                out.append((names[b["tool_use_id"]], b.get("is_error", False), b["content"]))
    return out


def shopper_turn(state: State, body: dict) -> list[dict]:
    persona = persona_of(body["system"])
    done = history(body["messages"])
    step = len(done)
    if state.model_mode == "liar":
        return [tool_use(step, "finish", {"completed": True, "blocker": "", "summary": "All done!"})]
    if state.model_mode == "loop":
        return [tool_use(step, "woo__list_products", {})]
    if done and done[-1][1]:
        blocker = ORDERS_BLOCKER if done[-1][0] == "woo__list_orders" else OTHER_BLOCKER
        return [tool_use(step, "finish", {"completed": False, "blocker": blocker, "summary": blocker})]
    results = {name: text for name, _, text in done}
    order_id = json.loads(results["checkout"])["order_id"] if "checkout" in results else None
    plans = {
        "budget-buyer": [
            ("woo__list_products", lambda: {}),
            ("checkout", lambda: {"product_id": cheap(results), "quantity": 1}),
            ("woo__get_order", lambda: {"id": order_id}),
        ],
        "orders-today": [
            ("woo__list_orders", lambda: {"date": "today"}),
            ("woo__get_order", lambda: {"id": json.loads(results["woo__list_orders"])["orders"][0]["id"]}),
        ],
        "price-check": [("woo__list_products", lambda: {"search": "Demo Tee"})],
        "buy-and-track": [
            ("woo__list_products", lambda: {"search": "Demo Tee"}),
            ("checkout", lambda: {"product_id": 7}),
            ("woo__list_orders", lambda: {"date": "today"}),
        ],
    }[persona]
    if step < len(plans):
        name, args = plans[step]
        return [{"type": "text", "text": "Let me look."}, tool_use(step, name, args())]
    return [tool_use(step, "finish", {"completed": True, "blocker": "", "summary": "Easy, it worked."})]


def cheap(results: dict) -> int:
    products = json.loads(results["woo__list_products"])["products"]
    return next(p["id"] for p in products if float(p["price"]) < 1000)


# ── The server ──────────────────────────────────────────────────────────────────────────────────


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def body(self) -> dict:
            n = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(n)) if n else {}

        def send(self, code: int, payload: dict | None, headers: dict | None = None):
            data = b"" if payload is None else json.dumps(payload).encode()
            self.send_response(code)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            if payload is not None:
                self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/wp-json/wc/store/v1/cart":
                return self.send(200, {"items": []}, {"Nonce": "n-1", "Cart-Token": "ct-1"})
            self.send(404, {"message": "not found"})

        def do_POST(self):
            if self.path == "/v1/messages":
                return self.messages()
            if self.path == "/mcp":
                return self.mcp()
            if self.path.startswith("/wp-json/wc/store/v1/"):
                return self.store()
            self.send(404, {"message": "not found"})

        def messages(self):
            body = self.body()
            with state.lock:
                state.model_requests += 1
                state.model_bodies.append(body)
            if self.headers.get("x-api-key") != ANTHROPIC_KEY or not self.headers.get("anthropic-version"):
                return self.send(401, {"type": "error", "error": {"type": "authentication_error"}})
            if state.model_mode == "down":
                return self.send(500, {"type": "error", "error": {"type": "api_error"}})
            if state.model_mode == "notfound":
                return self.send(404, {"type": "error", "error": {"type": "not_found_error"}})
            if state.refuse_temperature and "temperature" in body:
                err = {"type": "invalid_request_error", "message": "temperature is deprecated for this model."}
                return self.send(400, {"type": "error", "error": err})
            content = shopper_turn(state, body)
            stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn"
            self.send(
                200,
                {
                    "type": "message",
                    "role": "assistant",
                    "content": content,
                    "stop_reason": stop,
                    "usage": {"input_tokens": state.usage_in, "output_tokens": 50},
                },
            )

        def mcp(self):
            if self.headers.get("authorization") != f"Bearer {GATEWAY_KEY}":
                state.bad_auth += 1
                return self.send(401, {"error": {"code": "UNAUTHORIZED", "message": "no"}})
            pin = (self.headers.get("x-urumi-track") or "").lower()
            if state.dead_track and pin == state.dead_track:
                return self.send(502, None)
            track = state.answer_track or pin or "stable"
            with state.lock:
                state.pins.append((pin, track))
            msg = self.body()
            hdr = {"x-urumi-track": track}
            if "id" not in msg:
                return self.send(202, None, hdr)
            if msg["method"] == "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "urumi-gateway", "version": "0"}}
                return self.send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result}, hdr)
            name, args = msg["params"]["name"], msg["params"]["arguments"]
            if (pin, name) in state.tool_errors:
                err = {"error": {"code": "UPSTREAM_ERROR", "message": "Tool result too large"}}
                result = {"isError": True, "content": [{"type": "text", "text": json.dumps(err)}]}
            else:
                result = {"content": [{"type": "text", "text": json.dumps(self.tool(name, args))}]}
            self.send(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result}, hdr)

        def tool(self, name: str, args: dict) -> dict:
            if name == "woo__list_products":
                q = (args.get("search") or "").lower()
                return {"products": [p for p in PRODUCTS if q in p["name"].lower()]}
            if name == "woo__list_orders":
                ids = list(reversed(state.orders)) + [SEEDED_ORDER]
                return {"orders": [{"id": i, "status": "processing"} for i in ids]}
            if name == "woo__get_order":
                return {"order": {"id": args["id"], "status": "processing", "payment_method": "cod"}}
            raise AssertionError(name)

        def store(self):
            if self.headers.get("nonce") != "n-1" or self.headers.get("cart-token") != "ct-1":
                return self.send(401, {"code": "woocommerce_rest_missing_nonce", "message": "nonce"})
            body = self.body()
            if self.path.endswith("/cart/add-item"):
                return self.send(201, {"items_count": body["quantity"]})
            if self.path.endswith("/checkout"):
                assert body["payment_method"] == "cod"
                with state.lock:
                    order_id = 500 + len(state.orders)
                    state.orders.append(order_id)
                return self.send(200, {"order_id": order_id, "status": "processing"})
            self.send(404, {"message": "not found"})

    return Handler


class ShoppersTest(unittest.TestCase):
    def setUp(self):
        self.state = State()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.tmp.name, "userb.key")
        with open(self.key_file, "w") as f:
            f.write(GATEWAY_KEY + "\n")
        self.out_file = os.path.join(self.tmp.name, "shoppers.json")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def run_shoppers(self, *extra: str, key: str | None = ANTHROPIC_KEY) -> tuple[int, dict, str]:
        args = [
            "--base", self.url, "--store", self.url, "--anthropic-url", self.url,
            "--key-file", self.key_file, "--out", self.out_file, *extra,
        ]
        out, err = io.StringIO(), io.StringIO()
        old = dict(os.environ)
        for k in ("ANTHROPIC_API_KEY", "SHOPPER_MODEL", "SHOPPER_BUDGET_USD", "CANARY_API_KEY"):
            os.environ.pop(k, None)
        if key is not None:
            os.environ["ANTHROPIC_API_KEY"] = key
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = shoppers.main(args)
        finally:
            os.environ.clear()
            os.environ.update(old)
        with open(self.out_file, encoding="utf-8") as f:
            raw = f.read()
        printed = out.getvalue() + err.getvalue()
        for secret in (ANTHROPIC_KEY, GATEWAY_KEY):
            self.assertNotIn(secret, printed, "a key was printed")
            self.assertNotIn(secret, raw, "a key was written")
        return code, json.loads(raw), printed

    def test_happy_path_every_journey_completes_on_both_tracks(self):
        code, out, printed = self.run_shoppers()
        self.assertEqual(code, 0)
        for track in ("stable", "canary"):
            t = out["tracks"][track]
            self.assertEqual(
                (t["journeys"], t["valid"], t["invalid"], t["completed"], t["success_rate"]),
                (4, 4, 0, 4, 1.0),
                track,
            )
            self.assertEqual(t["blockers"], [])
            self.assertGreater(t["median_steps"], 0)
        personas = sorted(j["persona"] for j in out["journeys"] if j["track"] == "canary")
        self.assertEqual(personas, sorted(p["id"] for p in shoppers.PERSONAS))
        buyer = next(j for j in out["journeys"] if j["persona"] == "budget-buyer")
        self.assertEqual([t["name"] for t in buyer["tools"]], ["woo__list_products", "checkout", "woo__get_order"])
        self.assertIsInstance(buyer["order_id"], int)
        self.assertEqual(buyer["final"], "Easy, it worked.")
        self.assertEqual(len(self.state.orders), 4)  # 2 buying personas x 2 tracks
        # Pinned: every gateway request carried the journey's track, and that track answered.
        self.assertTrue(self.state.pins)
        self.assertTrue(all(pin == track and pin in ("stable", "canary") for pin, track in self.state.pins))
        self.assertEqual(self.state.bad_auth, 0)
        # Messages API: the limits of the brief.
        body = self.state.model_bodies[0]
        self.assertEqual((body["model"], body["max_tokens"], body["temperature"]), ("claude-haiku-5-5", 600, 0))
        self.assertEqual(out["usage"]["input_tokens"], 1000 * self.state.model_requests)
        self.assertAlmostEqual(out["spent_usd"], self.state.model_requests * (1000 * 1 + 50 * 5) / 1e6, places=4)
        self.assertIn("canary: 4/4 journeys completed", printed)

    def test_tool_error_on_canary_is_a_failure_with_the_shoppers_own_blocker(self):
        self.state.tool_errors = {("canary", "woo__list_orders")}
        _, out, printed = self.run_shoppers()
        stable, canary = out["tracks"]["stable"], out["tracks"]["canary"]
        self.assertEqual((stable["completed"], stable["valid"]), (4, 4))
        self.assertEqual((canary["completed"], canary["valid"], canary["invalid"]), (2, 4, 0))
        self.assertEqual(canary["success_rate"], 0.5)
        self.assertEqual(canary["blockers"], [ORDERS_BLOCKER, ORDERS_BLOCKER])
        failed = [j for j in out["journeys"] if j["track"] == "canary" and not j["completed"]]
        self.assertEqual(sorted(j["persona"] for j in failed), ["buy-and-track", "orders-today"])
        orders = next(t for t in failed[0]["tools"] if t["name"] == "woo__list_orders")
        self.assertFalse(orders["ok"])
        self.assertIn("Tool result too large", orders["error"])
        self.assertIn(f'blocker: "{ORDERS_BLOCKER}"', printed)

    def test_budget_guard_stops_new_turns(self):
        self.state.usage_in = 400_000  # $0.40 a turn at Haiku prices
        _, out, _ = self.run_shoppers("--budget-usd", "0.50", "--concurrency", "1")
        # Turn 1 ($0.40) and turn 2 (total $0.80) run; then the budget is spent and nothing starts.
        self.assertEqual(self.state.model_requests, 2)
        for t in out["tracks"].values():
            self.assertEqual(t["valid"], 0)
        reasons = {j["invalid"] for j in out["journeys"]}
        self.assertEqual(reasons, {"stopped: budget of $0.50 spent"})
        self.assertGreater(out["spent_usd"], 0.5)

    def test_no_anthropic_key_is_skipped_with_exit_0(self):
        code, out, printed = self.run_shoppers(key="")
        self.assertEqual(code, 0)
        self.assertEqual(out, {"skipped": "ANTHROPIC_API_KEY is not set"})
        self.assertEqual(self.state.model_requests, 0)
        self.assertIn("AI shoppers skipped", printed)

    def test_model_api_rejecting_every_request_is_skipped_and_stops_early(self):
        self.state.model_mode = "notfound"  # e.g. an unknown model id
        code, out, _ = self.run_shoppers("--concurrency", "1")
        self.assertEqual(code, 0)
        self.assertEqual(
            out, {"skipped": "Anthropic API failed before any journey completed: HTTP 404 not_found_error"}
        )
        self.assertEqual(self.state.model_requests, 1)  # fatal: the other journeys never call

    def test_model_api_down_is_retried_once_then_skipped(self):
        self.state.model_mode = "down"
        code, out, _ = self.run_shoppers("--tracks", "stable", "--journeys", "1")
        self.assertEqual(code, 0)
        self.assertIn("HTTP 500 api_error", out["skipped"])
        self.assertEqual(self.state.model_requests, 2)

    def test_answer_from_the_other_track_makes_the_journey_invalid_not_failed(self):
        self.state.answer_track = "stable"  # the pin is not honoured: everything lands on stable
        _, out, printed = self.run_shoppers()
        self.assertEqual(out["tracks"]["stable"]["completed"], 4)
        canary = out["tracks"]["canary"]
        self.assertEqual((canary["valid"], canary["invalid"], canary["success_rate"]), (0, 4, None))
        invalid = {j["invalid"] for j in out["journeys"] if j["track"] == "canary"}
        self.assertEqual(invalid, {"a response came from track 'stable', pinned 'canary'"})
        self.assertIn("INVALID", printed)

    def test_dead_pinned_pod_is_a_failure_the_shopper_sees(self):
        self.state.dead_track = "canary"  # proxy 502, no x-urumi-track
        _, out, _ = self.run_shoppers()
        canary = out["tracks"]["canary"]
        self.assertEqual((canary["valid"], canary["completed"]), (4, 0))
        self.assertEqual(out["tracks"]["stable"]["completed"], 4)
        self.assertIn(OTHER_BLOCKER, canary["blockers"])
        j = next(j for j in out["journeys"] if j["track"] == "canary")
        self.assertEqual(j["tools"][0], {"name": "initialize", "ok": False, "error": "initialize: HTTP 502"})

    def test_a_claimed_success_without_evidence_does_not_count(self):
        self.state.model_mode = "liar"  # says "completed" without calling a single tool
        _, out, _ = self.run_shoppers("--tracks", "canary")
        t = out["tracks"]["canary"]
        self.assertEqual((t["valid"], t["completed"]), (4, 0))
        buyer = next(j for j in out["journeys"] if j["persona"] == "budget-buyer")
        self.assertTrue(buyer["said_completed"])
        self.assertEqual(buyer["missing_evidence"], ["checkout", "order_seen:woo__get_order"])
        self.assertIn("harness saw no checkout", buyer["blocker"])

    def test_no_verdict_within_the_turn_limit_is_a_failure(self):
        self.state.model_mode = "loop"
        _, out, _ = self.run_shoppers("--tracks", "stable", "--journeys", "1", "--max-turns", "3")
        t = out["tracks"]["stable"]
        self.assertEqual((t["valid"], t["completed"]), (1, 0))
        self.assertEqual(t["blockers"], ["I gave up: I could not finish within 3 steps."])
        self.assertEqual(self.state.model_requests, 3)

    def test_a_model_that_refuses_temperature_runs_without_it(self):
        self.state.refuse_temperature = True
        _, out, _ = self.run_shoppers("--tracks", "stable", "--concurrency", "1")
        self.assertEqual(out["tracks"]["stable"]["completed"], 4)
        self.assertEqual(out["temperature"], "model default (the model refuses temperature)")
        sent = [("temperature" in b) for b in self.state.model_bodies]
        self.assertEqual(sent[:2], [True, False])  # refused once, then never sent again
        self.assertNotIn(True, sent[1:])

    def test_the_anthropic_key_can_come_from_a_dotenv_file(self):
        env_file = os.path.join(self.tmp.name, ".env.local")
        with open(env_file, "w") as f:
            f.write(f"POSTGRES_PASSWORD=x\nexport ANTHROPIC_API_KEY='{ANTHROPIC_KEY}'\n")
        _, out, _ = self.run_shoppers("--tracks", "stable", "--journeys", "1", "--env-file", env_file, key="")
        self.assertEqual(out["tracks"]["stable"]["completed"], 1)
        _, out, _ = self.run_shoppers("--env-file", os.path.join(self.tmp.name, "none"), key="")
        self.assertEqual(out, {"skipped": "ANTHROPIC_API_KEY is not set"})

    def test_bad_flags_and_no_gateway_key_are_usage_errors(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(shoppers.main(["--tracks", "blue"]), shoppers.EXIT_USAGE)
            os.environ["ANTHROPIC_API_KEY"] = ANTHROPIC_KEY
            try:
                code = shoppers.main(["--key-file", os.path.join(self.tmp.name, "none"), "--out", ""])
            finally:
                os.environ.pop("ANTHROPIC_API_KEY", None)
        self.assertEqual(code, shoppers.EXIT_USAGE)


if __name__ == "__main__":
    unittest.main()
