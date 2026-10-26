#!/usr/bin/env bash
# Offline checks for the multi-store RBAC in charts/platform (ADR 015). Renders the chart with
# `helm template` and asserts that, with multiStore.enabled:
#   - exactly one ClusterRoleBinding exists for stores, binding only the gateway ServiceAccount to the
#     provisioner ClusterRole, which grants EXACTLY namespaces get,list,create,patch,delete +
#     rolebindings create + clusterroles bind (resourceNames = the manager and bootstrap roles);
#   - the manager ClusterRole (bound per store namespace by the gateway) has no wildcard, no
#     get/list/watch on Secrets, no pods/exec|log|attach, no roles/rolebindings, no delete on PVCs,
#     and is NOT bound cluster-wide; the bootstrap ClusterRole touches only the woo-api Secret
#     (+ create);
#   - the ValidatingAdmissionPolicy + Binding exist (Deny), match only the gateway's user, and cover
#     namespaces CREATE/UPDATE/DELETE and rolebindings CREATE/UPDATE;
#   - the gateway gets MULTI_STORE_* env, the bootstrap scripts mount, a projected token, and
#     egress to store woo-mcp pods on 8080 only;
#   - with multiStore.enabled=false (values-prod.yaml default) none of it is rendered.
#   tests/infra/stores-chart.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHART="$ROOT/charts/platform"
for cmd in helm kubectl node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "FAIL '$cmd' not found on PATH"
    exit 1
  }
done

render() { # render <values file> [helm args...] -> JSON documents on stdout
  local values=$1
  shift
  helm template urumi "$CHART" -n urumi -f "$CHART/$values" "$@" |
    kubectl --kubeconfig /dev/null annotate --local -f - stores-chart=1 -o json
}

# shellcheck disable=SC2016 # JS source, not shell
CHECK_JS='
const raw = require("fs").readFileSync(0, "utf8").trim();
const docs = raw ? JSON.parse("[" + raw.replace(/\n}\n{/g, "\n},\n{") + "]") : [];
const enabled = process.env.STORES === "1";
const problems = [];
const of = (kind) => docs.filter((d) => d.kind === kind);
const stores = (d) => (d.metadata.labels || {})["app.kubernetes.io/component"] === "stores";
const rules = (role) => {
  const got = {};
  for (const r of role.rules) for (const g of r.apiGroups) for (const res of r.resources) {
    if (r.verbs.includes("*") || res.includes("*") || g === "*") problems.push(`wildcard in ${role.metadata.name} ${g}/${res}`);
    got[`${g}/${res}${r.resourceNames ? "[" + r.resourceNames.join(",") + "]" : ""}`] = [...r.verbs].sort().join(",");
  }
  return got;
};
const same = (a, b) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
const gw = of("Deployment").find((d) => d.metadata.name === "urumi-gateway");
const pod = gw.spec.template.spec;
const env = Object.fromEntries(pod.containers[0].env.map((e) => [e.name, e.value]));
const vap = of("ValidatingAdmissionPolicy");
if (!enabled) {
  if (of("ClusterRole").filter(stores).length || of("ClusterRoleBinding").filter(stores).length)
    problems.push("store ClusterRoles rendered while multiStore.enabled=false");
  if (vap.length) problems.push("admission policy rendered while multiStore.enabled=false");
  if (env.MULTI_STORE_ENABLED) problems.push("gateway has MULTI_STORE_ENABLED while off");
} else {
  const crs = of("ClusterRole").filter(stores);
  const byName = Object.fromEntries(crs.map((c) => [c.metadata.name, c]));
  const prov = byName["urumi-store-provisioner"], mgr = byName["urumi-store-manager"], boot = byName["urumi-store-bootstrap"];
  if (crs.length !== 3 || !prov || !mgr || !boot) problems.push(`expected the 3 store ClusterRoles, got ${crs.map((c) => c.metadata.name)}`);
  else {
    const want = {
      "/namespaces": "create,delete,get,list,patch",
      "rbac.authorization.k8s.io/rolebindings": "create",
      "rbac.authorization.k8s.io/clusterroles[urumi-store-manager,urumi-store-bootstrap]": "bind",
    };
    const got = rules(prov);
    if (!same(got, want)) problems.push(`provisioner ClusterRole is not minimal: ${JSON.stringify(got)}`);
    const m = rules(mgr);
    for (const [k, v] of Object.entries(m)) {
      if (k === "/secrets" && /get|list|watch|delete/.test(v)) problems.push(`manager can ${v} secrets`);
      if (/pods\/|roles|rolebindings|clusterroles|nodes|namespaces/.test(k)) problems.push(`manager has ${k}`);
      if (k === "/persistentvolumeclaims" && v.includes("delete")) problems.push("manager can delete PVCs");
      if (k === "/pods" && v !== "list") problems.push(`manager pods verbs ${v}`);
    }
    const b = rules(boot);
    if (!same(b, { "/secrets[woo-api]": "get,patch,update", "/secrets": "create" }))
      problems.push(`bootstrap ClusterRole is not minimal: ${JSON.stringify(b)}`);
  }
  const crbs = of("ClusterRoleBinding").filter(stores);
  if (crbs.length !== 1) problems.push(`expected 1 store ClusterRoleBinding, got ${crbs.length}`);
  for (const c of crbs) {
    if (c.roleRef.name !== "urumi-store-provisioner") problems.push(`ClusterRoleBinding binds ${c.roleRef.name}`);
    if (JSON.stringify(c.subjects) !== JSON.stringify([{ kind: "ServiceAccount", name: "urumi-gateway", namespace: "urumi" }]))
      problems.push(`ClusterRoleBinding subjects: ${JSON.stringify(c.subjects)}`);
  }
  for (const b of [...of("ClusterRoleBinding"), ...of("RoleBinding")])
    if (["urumi-store-manager", "urumi-store-bootstrap"].includes(b.roleRef.name)) problems.push(`${b.roleRef.name} is bound by the chart (${b.kind})`);
  if (vap.length !== 1) problems.push("no store admission policy");
  else {
    const p = vap[0].spec;
    if (p.failurePolicy !== "Fail") problems.push("admission policy does not fail closed");
    if (!p.matchConditions.some((c) => c.expression.includes("system:serviceaccount:urumi:urumi-gateway")))
      problems.push("admission policy does not match the gateway user");
    const res = p.matchConstraints.resourceRules.map((r) => `${r.resources}:${[...r.operations].sort()}`).sort();
    if (JSON.stringify(res) !== JSON.stringify(["namespaces:CREATE,DELETE,UPDATE", "rolebindings:CREATE,UPDATE"]))
      problems.push(`admission policy covers ${JSON.stringify(res)}`);
    if (p.validations.length < 5) problems.push("admission policy has too few validations");
  }
  const vb = of("ValidatingAdmissionPolicyBinding");
  if (vb.length !== 1 || JSON.stringify(vb[0].spec.validationActions) !== "[\"Deny\"]") problems.push("admission policy binding missing or not Deny");
  if (env.MULTI_STORE_ENABLED !== "true" || !env.MULTI_STORE_CONFIG || !env.MULTI_STORE_MAX_STORES) problems.push("gateway lacks MULTI_STORE_* env");
  else {
    const cfg = JSON.parse(env.MULTI_STORE_CONFIG);
    if (cfg.clusterRoles.manager !== "urumi-store-manager") problems.push("MULTI_STORE_CONFIG names the wrong manager role");
    if (JSON.stringify(env.MULTI_STORE_CONFIG).match(/password|secret/i) && !/tlsSecretName/.test(env.MULTI_STORE_CONFIG)) problems.push("config mentions a secret");
  }
  if (!(pod.volumes || []).some((v) => v.name === "store-bootstrap" && v.configMap && v.configMap.name === "urumi-bootstrap"))
    problems.push("gateway does not mount the bootstrap scripts");
  if (pod.serviceAccountName !== "urumi-gateway" || pod.automountServiceAccountToken !== false) problems.push("gateway SA/token setup wrong");
  const eg = of("NetworkPolicy").find((p) => p.metadata.name === "urumi-gateway-egress");
  const rule = eg.spec.egress.find((r) => r.to.some((t) => t.namespaceSelector && t.namespaceSelector.matchLabels && t.namespaceSelector.matchLabels["urumi.io/store"] === "true"));
  if (!rule || rule.ports.length !== 1 || rule.ports[0].port !== 8080 || rule.to[0].podSelector.matchLabels["app.kubernetes.io/component"] !== "woo-mcp")
    problems.push("gateway egress to stores is not exactly woo-mcp:8080");
}
for (const p of problems) console.log("  " + p);
process.exit(problems.length ? 1 : 0);
'

failed=0
check() { # check <name> <STORES 0|1> <values> [helm args...]
  local name=$1 on=$2 values=$3
  shift 3
  if render "$values" "$@" | STORES=$on node -e "$CHECK_JS"; then
    echo "PASS stores-chart ($name)"
  else
    echo "FAIL stores-chart ($name)"
    failed=1
  fi
}
check "values-local.yaml" 1 values-local.yaml
check "values-local.yaml, hosted off" 1 values-local.yaml --set hosted.enabled=false
check "values-prod.yaml (off by default)" 0 values-prod.yaml
check "values-prod.yaml, opted in" 1 values-prod.yaml --set multiStore.enabled=true
exit "$failed"
