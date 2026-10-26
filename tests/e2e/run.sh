#!/usr/bin/env bash
# Runs the end-to-end flows D1–D13 against the local cluster through the Ingress
# (http://app.localtest.me, http://store.localtest.me).
#   tests/e2e/run.sh all            seed, then D1..D13 (a new run: fresh run id, start time, audit
#                                   expectations)
#   tests/e2e/run.sh D3 [D5 ...]    those steps, in the order given, within the current run (seeds
#                                   first if there is no run yet); `seed` is also a valid step
# Each step prints exactly `PASS Dn` or `FAIL Dn: <reason>`; its diagnostics go to
# tests/e2e/.out/Dn.log. Exits non-zero if any step fails. Steps live in tests/e2e/dN-*.sh.
set -uo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
STEP=run
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"

[ "$#" -gt 0 ] || die "usage: tests/e2e/run.sh <D1..D13|seed|all> [...]"
for cmd in kubectl curl jq node; do need "$cmd" "Install $cmd"; done

new_run() {
  local start
  start=$(server_now) || die "gateway not reachable at $APP_URL"
  printf 'RUN_ID=%s\nRUN_START=%s\n' "$(date +%Y%m%d%H%M%S)" "$start" >"$RUN_ENV"
  : >"$EXPECT"
}

steps=""
for arg in "$@"; do
  case "$arg" in
    all) steps="$steps seed D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12 D13" ;;
    seed | D[1-9] | D1[0-9]) steps="$steps $arg" ;;
    d[1-9] | d1[0-9]) steps="$steps $(printf '%s' "$arg" | tr d D)" ;;
    *) die "unknown step '$arg' (expected D1..D13, seed or all)" ;;
  esac
done
case " $* " in *" all "*) new_run ;; esac
if [ ! -f "$RUN_ENV" ]; then
  new_run
  case "$steps" in *seed*) ;; *) steps="seed $steps" ;; esac
elif [ ! -f "$SEED_ENV" ]; then
  case "$steps" in *seed*) ;; *) steps="seed $steps" ;; esac
fi

failed=0
seed_failed=0
for step in $steps; do
  log="$E2E_OUT/$step.log"
  if [ "$step" = seed ]; then
    script="$E2E_DIR/seed.sh"
  else
    if [ "$seed_failed" = 1 ]; then
      echo "FAIL $step: seed failed (see $E2E_OUT/seed.log)"
      failed=1
      continue
    fi
    script=$(ls "$E2E_DIR"/"$(printf '%s' "$step" | tr D d)"-*.sh 2>/dev/null | head -1)
    if [ -z "$script" ]; then
      echo "FAIL $step: no script tests/e2e/$(printf '%s' "$step" | tr D d)-*.sh"
      failed=1
      continue
    fi
  fi
  out=$(STEP=$step bash "$script" 2>"$log")
  rc=$?
  line=$(printf '%s\n' "$out" | grep -E "^(PASS|FAIL) $step(:|$)" | tail -1)
  if [ "$rc" = 0 ] && [ "$line" = "PASS $step" ]; then
    echo "$line"
  else
    [ -n "$line" ] && [ "$line" != "PASS $step" ] || line="FAIL $step: exited $rc without a result (see $log)"
    echo "$line"
    failed=1
    [ "$step" = seed ] && seed_failed=1
  fi
done
exit "$failed"
