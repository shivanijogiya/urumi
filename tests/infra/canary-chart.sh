#!/usr/bin/env bash
# Offline checks for the gateway canary templates (#23, H2; no cluster needed). Renders
# charts/platform with values-local.yaml and asserts:
#   off (default)  no canary Deployment/Service/IngressRoute; the stable gateway is labelled
#                  track=stable with TRACK=stable and no FAULT_INJECT_*; the Postgres, woo-mcp and
#                  everything NetworkPolicies admit component gateway only
#   on             canary Deployment urumi-gateway-canary: 1 replica, the canary tag, track=canary,
#                  TRACK=canary, FAULT_INJECT_* only when set; its selector and the canary Service
#                  select component=gateway-canary while the stable Deployment/Service selectors are
#                  unchanged (so they never match canary pods); the IngressRoute splits
#                  /api + /mcp 80/20 by default (or the weight given), on `web` (or `websecure` +
#                  the app TLS Secret); the NetworkPolicies admit gateway and gateway-canary
#   bad input      weight outside 0..100, or no canary tag, fails the render
# Prints PASS/FAIL per check; exits non-zero if any fails.
#   tests/infra/canary-chart.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHART="$ROOT/charts/platform"
failed=0

pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1${2:+: $2}"
  failed=1
}

# render <helm args...> : rendered objects as a JSON array on stdout.
render() {
  helm template urumi "$CHART" -n urumi -f "$CHART/values-local.yaml" "$@" |
    kubectl --kubeconfig /dev/null annotate --local -f - canary-chart=1 -o json |
    node -e '
      const raw = require("fs").readFileSync(0, "utf8").trim();
      process.stdout.write(raw ? "[" + raw.replace(/\n}\n{/g, "\n},\n{") + "]" : "[]");'
}

# check <name> <json> <js expression over `docs` that returns a problem string or "">
check() {
  local problem
  problem=$(printf '%s' "$2" | node -e '
    const docs = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const get = (kind, name) => docs.find((d) => d.kind === kind && d.metadata.name === name);
    const env = (dep) => Object.fromEntries(
      dep.spec.template.spec.containers[0].env.map((e) => [e.name, e.value ?? "<ref>"]));
    const peers = (np) => {
      const sel = get("NetworkPolicy", np).spec.ingress[0].from[0].podSelector;
      return (sel.matchExpressions || []).find((e) => e.key === "app.kubernetes.io/component")
        .values.join(",");
    };
    const r = (0, eval)("(docs, get, env, peers) => { " + process.argv[1] + " }")(docs, get, env, peers);
    process.stdout.write(r || "");' "$3" 2>&1) || problem="check crashed: $problem"
  if [ -z "$problem" ]; then pass "$1"; else fail "$1" "$problem"; fi
}

off=$(render)
check "canary off: no canary objects" "$off" '
  const extra = docs.filter((d) => /canary/.test(d.metadata.name) || d.kind === "IngressRoute");
  return extra.length ? "unexpected " + extra.map((d) => d.kind + "/" + d.metadata.name) : "";'
check "canary off: stable is track=stable, TRACK=stable, no fault env" "$off" '
  const d = get("Deployment", "urumi-gateway");
  const e = env(d);
  if (d.spec.template.metadata.labels.track !== "stable") return "pod label track != stable";
  if (e.TRACK !== "stable") return "TRACK=" + e.TRACK;
  if ("FAULT_INJECT_ERROR_RATE" in e || "FAULT_INJECT_LATENCY_MS" in e) return "fault env on stable";'
check "canary off: NetworkPolicies admit component gateway only" "$off" '
  for (const np of ["urumi-postgres", "urumi-woo-mcp", "urumi-everything"])
    if (peers(np) !== "gateway") return np + ": " + peers(np);'

on=$(render --set gatewayCanary.enabled=true --set gatewayCanary.image.tag=c1)
check "canary on: Deployment urumi-gateway-canary runs the canary tag as track=canary" "$on" '
  const d = get("Deployment", "urumi-gateway-canary");
  if (!d) return "no canary Deployment";
  const c = d.spec.template.spec.containers[0];
  const e = env(d);
  if (d.spec.replicas !== 1) return "replicas " + d.spec.replicas;
  if (!c.image.endsWith("/urumi-gateway:c1")) return "image " + c.image;
  if (d.spec.template.metadata.labels.track !== "canary") return "pod label track";
  if (e.TRACK !== "canary") return "TRACK=" + e.TRACK;
  if ("FAULT_INJECT_ERROR_RATE" in e) return "fault env without faultInject";
  if (!c.livenessProbe || !c.readinessProbe || !c.resources.limits) return "probes/limits missing";'
check "canary on: selectors keep stable and canary pods apart" "$on" '
  const comp = (o) => o["app.kubernetes.io/component"];
  const stable = get("Deployment", "urumi-gateway"), canary = get("Deployment", "urumi-gateway-canary");
  if (comp(stable.spec.selector.matchLabels) !== "gateway") return "stable Deployment selector changed";
  if (comp(get("Service", "urumi-gateway").spec.selector) !== "gateway") return "stable Service selector changed";
  if (comp(canary.spec.selector.matchLabels) !== "gateway-canary") return "canary Deployment selector";
  if (comp(canary.spec.template.metadata.labels) !== "gateway-canary") return "canary pod component";
  if (comp(get("Service", "urumi-gateway-canary").spec.selector) !== "gateway-canary") return "canary Service selector";'
check "canary on: IngressRoute sends 20% of /api + /mcp to the canary" "$on" '
  const ir = get("IngressRoute", "urumi-app-canary");
  if (!ir) return "no IngressRoute";
  if (ir.apiVersion !== "traefik.io/v1alpha1") return ir.apiVersion;
  const rt = ir.spec.routes[0];
  if (!rt.match.includes("Host(`app.localtest.me`)") || !rt.match.includes("(api|mcp)")) return rt.match;
  const w = Object.fromEntries(rt.services.map((s) => [s.name, s.weight]));
  if (w["urumi-gateway"] !== 80 || w["urumi-gateway-canary"] !== 20) return JSON.stringify(w);
  if (!(rt.priority > 100)) return "priority " + rt.priority;
  if (ir.spec.entryPoints.join() !== "web" || ir.spec.tls) return "entryPoints/tls";'
check "canary on: NetworkPolicies admit gateway and gateway-canary" "$on" '
  for (const np of ["urumi-postgres", "urumi-woo-mcp", "urumi-everything"])
    if (peers(np) !== "gateway,gateway-canary") return np + ": " + peers(np);'

bad=$(render --set gatewayCanary.enabled=true --set gatewayCanary.image.tag=c2 \
  --set gatewayCanary.weight=35 --set gatewayCanary.faultInject.errorRate=0.5 \
  --set gatewayCanary.faultInject.latencyMs=300 --set app.tls.enabled=true \
  --set app.tls.secretName=app-tls)
check "canary on: weight, fault env and TLS are honoured; stable has no fault env" "$bad" '
  const e = env(get("Deployment", "urumi-gateway-canary"));
  if (e.FAULT_INJECT_ERROR_RATE !== "0.5" || e.FAULT_INJECT_LATENCY_MS !== "300") return "fault env " + JSON.stringify(e);
  if ("FAULT_INJECT_ERROR_RATE" in env(get("Deployment", "urumi-gateway"))) return "fault env on stable";
  const ir = get("IngressRoute", "urumi-app-canary");
  const w = Object.fromEntries(ir.spec.routes[0].services.map((s) => [s.name, s.weight]));
  if (w["urumi-gateway"] !== 65 || w["urumi-gateway-canary"] !== 35) return JSON.stringify(w);
  if (ir.spec.entryPoints.join() !== "websecure" || ir.spec.tls.secretName !== "app-tls") return "tls";'

# refuses <name> <helm args...> : the render must fail.
refuses() {
  local name=$1
  shift
  if helm template urumi "$CHART" -n urumi -f "$CHART/values-local.yaml" "$@" >/dev/null 2>&1; then
    fail "$name" "render succeeded"
  else
    pass "$name"
  fi
}
refuses "canary on without an image tag fails the render" --set gatewayCanary.enabled=true
refuses "canary weight 101 fails the render" --set gatewayCanary.enabled=true \
  --set gatewayCanary.image.tag=c1 --set gatewayCanary.weight=101

exit "$failed"
