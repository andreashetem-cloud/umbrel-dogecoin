#!/usr/bin/env bash
#
# End-to-end test. Boots a real dogecoind in regtest, generates the config the
# way the container entrypoint does, starts the dashboard against it, and
# asserts every endpoint and a set of edge cases.
#
# Runs anywhere with bash, curl, openssl and node — no Docker required.
#
#   ./test/integration.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
DOGE_VERSION="${DOGE_VERSION:-1.14.9}"
RPC_PORT="${RPC_PORT:-23555}"
UI_PORT="${UI_PORT:-23100}"
RPC_USER="umbrel"
RPC_PASSWORD="integration-test-password"

PASS=0
FAIL=0
SKIP=0
EXPECTED_CHECKS=55
DOGE_PID=""
UI_PID=""

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '\033[2m%s\033[0m\n' "$*"; }

ok()   { PASS=$((PASS + 1)); green "  ✓ $1"; }
skip() { SKIP=$((SKIP + 1)); printf '\033[33m  ~ skipped: %s\033[0m\n' "$1"; }
bad()  {
  FAIL=$((FAIL + 1))
  red "  ✗ $1"
  # NB: must return 0. A non-zero return here would abort the whole suite
  # under `set -e`, hiding every check after the first failure.
  if [[ $# -gt 1 ]]; then printf '      %s\n' "$2"; fi
  return 0
}

assert_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi
}
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "'$3' not found in: ${2:0:200}"; fi
}
assert_not_contains() {
  # An empty haystack means the request failed — that is a failed check, not a
  # passing one. A test that passes because nothing happened is worse than none.
  if [[ -z "$2" ]]; then
    bad "$1" "nothing to check — the response was empty"
  elif [[ "$2" != *"$3"* ]]; then
    ok "$1"
  else
    bad "$1" "'$3' should NOT appear in: ${2:0:200}"
  fi
}

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [[ -n "${UI_PID}" ]]; then kill "${UI_PID}" 2>/dev/null || true; fi
  if [[ -n "${DOGE_PID}" ]]; then kill "${DOGE_PID}" 2>/dev/null || true; fi
  sleep 1
  rm -rf "${WORK}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
info "Static checks"
# ---------------------------------------------------------------------------
if node --check "${REPO_ROOT}/images/ui/src/server.js"; then
  ok "server.js parses"
else
  bad "server.js parses"
fi

shell_ok=1
for f in "${REPO_ROOT}"/images/core/*.sh "${REPO_ROOT}"/scripts/*.sh "${REPO_ROOT}"/doge-dogecoin-node/exports.sh "${REPO_ROOT}"/test/*.sh; do
  bash -n "$f" || { shell_ok=0; echo "      syntax error in $f"; }
done
if [[ ${shell_ok} -eq 1 ]]; then ok "all shell scripts parse"; else bad "all shell scripts parse"; fi

HAVE_YAML=0
if command -v python3 >/dev/null && python3 -c "import yaml" 2>/dev/null; then
  HAVE_YAML=1
  if python3 "${REPO_ROOT}/test/validate_manifest.py"; then
    ok "manifest + compose validation"
  else
    bad "manifest + compose validation" "see the errors above"
  fi
else
  skip "manifest + compose validation (python3 with PyYAML not available)"
fi

# HTML must not contain inline style attributes: our CSP uses a nonce, which
# does not whitelist attribute styles.
if grep -qE '<[^>]+ style="' "${REPO_ROOT}/images/ui/src/index.html"; then
  bad "no inline style attributes (blocked by CSP)"
else
  ok "no inline style attributes (CSP-safe)"
fi

# docker compose validates the file properly, but only if app_proxy has an
# image — umbrelOS merges that in from its own fragment at runtime, so we stub
# it the same way before validating.
if [[ ${HAVE_YAML} -eq 1 ]] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  STUB_COMPOSE="${WORK}/compose-check.yml"
  python3 - "${REPO_ROOT}/doge-dogecoin-node/docker-compose.yml" "${STUB_COMPOSE}" <<'PYEOF'
import sys, yaml
src, dst = sys.argv[1], sys.argv[2]
c = yaml.safe_load(open(src))
c.pop("version", None)
c["services"]["app_proxy"]["image"] = "getumbrel/app-proxy:1.7.0"
yaml.safe_dump(c, open(dst, "w"), sort_keys=False)
PYEOF
  if APP_DATA_DIR=/tmp/appdata DEVICE_DOMAIN_NAME=umbrel.local \
     TOR_PROXY_IP=10.21.21.11 TOR_PROXY_PORT=9050 \
     APP_DOGECOIN_NODE_RPC_USER=umbrel APP_DOGECOIN_NODE_RPC_PASS=test \
     docker compose -f "${STUB_COMPOSE}" config --quiet 2>"${WORK}/compose.err"; then
    ok "docker compose accepts the app's compose file"
  else
    bad "docker compose accepts the app's compose file" "$(cat "${WORK}/compose.err")"
  fi
else
  skip "docker compose validation (docker CLI or PyYAML not available)"
fi

# ---------------------------------------------------------------------------
info "Fetching Dogecoin Core ${DOGE_VERSION}"
# ---------------------------------------------------------------------------
case "$(uname -m)" in
  x86_64) DOGE_ARCH="x86_64-linux-gnu"; DOGE_SHA="4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8" ;;
  aarch64|arm64) DOGE_ARCH="aarch64-linux-gnu"; DOGE_SHA="6928c895a20d0bcb6d5c7dcec753d35c884a471aaf8ad4242a89a96acb4f2985" ;;
  *) red "Unsupported test architecture $(uname -m)"; exit 1 ;;
esac

TARBALL="dogecoin-${DOGE_VERSION}-${DOGE_ARCH}.tar.gz"
CACHE="${TMPDIR:-/tmp}/${TARBALL}"
if [[ ! -f "${CACHE}" ]]; then
  curl -fsSL --retry 3 -o "${CACHE}" \
    "https://github.com/dogecoin/dogecoin/releases/download/v${DOGE_VERSION}/${TARBALL}"
fi
echo "${DOGE_SHA}  ${CACHE}" | sha256sum -c - >/dev/null && ok "release tarball checksum matches the signed SHA256SUMS"
mkdir -p "${WORK}/bin" && tar -xzf "${CACHE}" -C "${WORK}/bin" --strip-components=1

# ---------------------------------------------------------------------------
info "Starting dogecoind (regtest) with rpcauth"
# ---------------------------------------------------------------------------
DATADIR="${WORK}/data"
mkdir -p "${DATADIR}"
SALT="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HMAC="$(printf '%s' "${RPC_PASSWORD}" | openssl dgst -sha256 -hmac "${SALT}" -r | cut -d' ' -f1)"
CONF="${DATADIR}/dogecoin.conf"
cat > "${CONF}" <<EOF
regtest=1
server=1
listen=0
printtoconsole=0
disablewallet=1
shrinkdebugfile=1
rpcauth=${RPC_USER}:${SALT}\$${HMAC}
rpcallowip=127.0.0.1
rpcbind=127.0.0.1
rpcport=${RPC_PORT}
EOF

"${WORK}/bin/bin/dogecoind" -datadir="${DATADIR}" -conf="${CONF}" -daemon
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null --user "${RPC_USER}:${RPC_PASSWORD}" \
      --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:${RPC_PORT}/"; then break; fi
  sleep 1
done
DOGE_PID="$(pgrep -f "dogecoind -datadir=${DATADIR}" | head -1 || true)"

assert_not_contains "rpcauth config contains no plaintext password" "$(cat "${CONF}")" "${RPC_PASSWORD}"

code=$(curl -s -o /dev/null -w '%{http_code}' --user "${RPC_USER}:${RPC_PASSWORD}" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' "http://127.0.0.1:${RPC_PORT}/")
assert_eq "rpcauth accepts the correct password" "${code}" "200"

code=$(curl -s -o /dev/null -w '%{http_code}' --user "${RPC_USER}:wrong-password" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' "http://127.0.0.1:${RPC_PORT}/")
assert_eq "rpcauth rejects a wrong password with 401" "${code}" "401"

wallet=$(curl -s --user "${RPC_USER}:${RPC_PASSWORD}" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getbalance","params":[]}' "http://127.0.0.1:${RPC_PORT}/")
assert_contains "wallet RPCs are disabled" "${wallet}" "Method not found"

# Every RPC method the dashboard is allowed to call must exist on this build.
for method in getblockchaininfo getnetworkinfo getmempoolinfo getmininginfo getpeerinfo getnettotals getbestblockhash; do
  out=$(curl -s --user "${RPC_USER}:${RPC_PASSWORD}" \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"${method}\",\"params\":[]}" "http://127.0.0.1:${RPC_PORT}/")
  if [[ "${out}" == *'"error":null'* || ( "${out}" == *'"result"'* && "${out}" != *'Method not found'* ) ]]; then
    ok "RPC ${method} exists on Dogecoin Core ${DOGE_VERSION}"
  else
    bad "RPC ${method} exists" "${out:0:160}"
  fi
done

# Regression guard: Dogecoin Core 1.14 has no `uptime` RPC. Nothing may call it.
if grep -rn "uptime" "${REPO_ROOT}/images" --include='*.js' --include='*.sh' \
     | grep -vE ':[[:space:]]*(#|//|\*)' | grep -q .; then
  bad "nothing calls the non-existent 'uptime' RPC"
else
  ok "nothing calls the non-existent 'uptime' RPC"
fi

# ---------------------------------------------------------------------------
info "Starting the dashboard"
# ---------------------------------------------------------------------------
RPC_HOST=127.0.0.1 RPC_PORT="${RPC_PORT}" RPC_USER="${RPC_USER}" RPC_PASSWORD="${RPC_PASSWORD}" \
  DATA_DIR="${DATADIR}" CHAIN_DIR="${DATADIR}/regtest" DEVICE_DOMAIN_NAME="umbrel.local" \
  PORT="${UI_PORT}" node "${REPO_ROOT}/images/ui/src/server.js" > "${WORK}/ui.log" 2>&1 &
UI_PID=$!
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:${UI_PORT}/health" && break
  sleep 1
done

BASE="http://127.0.0.1:${UI_PORT}"

assert_eq "GET /health" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")" "200"
assert_eq "GET / serves the dashboard" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/")" "200"
assert_eq "unknown paths 404" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/nope")" "404"
assert_eq "POST is rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/status")" "405"
assert_eq "favicon returns 204 instead of 404 noise" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/favicon.ico")" "204"

HEADERS="$(curl -s -D - -o /dev/null "${BASE}/")"
assert_contains "Content-Security-Policy is set"      "${HEADERS}" "Content-Security-Policy"
assert_contains "CSP uses a nonce, not unsafe-inline" "${HEADERS}" "script-src 'nonce-"
assert_not_contains "CSP has no unsafe-inline"        "${HEADERS}" "unsafe-inline"
assert_contains "X-Content-Type-Options: nosniff"     "${HEADERS}" "nosniff"
assert_contains "Referrer-Policy: no-referrer"        "${HEADERS}" "no-referrer"
assert_contains "responses are not cached"            "${HEADERS}" "no-store"

HTML="$(curl -s "${BASE}/")"
assert_not_contains "nonce placeholder was substituted" "${HTML}" "__CSP_NONCE__"

N1="$(curl -s -D - -o /dev/null "${BASE}/" | grep -i 'content-security-policy' || true)"
N2="$(curl -s -D - -o /dev/null "${BASE}/" | grep -i 'content-security-policy' || true)"
if [[ "${N1}" != "${N2}" ]]; then ok "CSP nonce differs per request"; else bad "CSP nonce differs per request"; fi

STATUS="$(curl -s "${BASE}/api/status")"
assert_contains "status reports ok"                 "${STATUS}" '"ok":true'
assert_contains "status includes the node version"  "${STATUS}" "Shibetoshi:${DOGE_VERSION}"
assert_contains "status includes a peers array"     "${STATUS}" '"peers"'
assert_contains "status includes traffic totals"    "${STATUS}" '"traffic"'
assert_not_contains "status does NOT leak the RPC password" "${STATUS}" "${RPC_PASSWORD}"

CREDS="$(curl -s "${BASE}/api/credentials")"
assert_contains "credentials endpoint returns the password over loopback" "${CREDS}" "${RPC_PASSWORD}"

# A sibling Umbrel app reaching us over the shared docker network is not
# loopback, and must be refused. Simulate it by connecting over a non-loopback
# address of this host while CREDENTIALS_ALLOW_HOST is unset.
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${HOST_IP}" ]]; then
  skip "cross-network credential checks (no non-loopback address on this host)"
  skip "refused response carries no password"
  skip "widget endpoints stay reachable for umbreld"
fi
if [[ -n "${HOST_IP}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://${HOST_IP}:${UI_PORT}/api/credentials" || echo 000)
  if [[ "${code}" == "403" ]]; then
    ok "credentials are refused to non-proxy peers (403)"
  else
    bad "credentials are refused to non-proxy peers" "got HTTP ${code} from ${HOST_IP}"
  fi
  body=$(curl -s "http://${HOST_IP}:${UI_PORT}/api/credentials" 2>/dev/null || true)
  assert_not_contains "refused response carries no password" "${body}" "${RPC_PASSWORD}"
  # widget + status endpoints must stay reachable — umbreld polls them from
  # outside this container.
  wcode=$(curl -s -o /dev/null -w '%{http_code}' "http://${HOST_IP}:${UI_PORT}/api/widget/sync" || echo 000)
  if [[ "${wcode}" == "200" ]]; then
    ok "widget endpoints stay reachable for umbreld"
  else
    bad "widget endpoints stay reachable for umbreld" "got HTTP ${wcode}"
  fi
fi

SYNCW="$(curl -s "${BASE}/api/widget/sync")"
assert_contains "sync widget has the right type"    "${SYNCW}" '"type":"text-with-progress"'
assert_contains "sync widget has a progress value"  "${SYNCW}" '"progress"'
# regtest genesis reports initialblockdownload=true, so the widget must not claim 100%.
assert_not_contains "sync widget never claims 100% during IBD" "${SYNCW}" '"text":"100%"'

STATSW="$(curl -s "${BASE}/api/widget/stats")"
assert_contains "stats widget has the right type" "${STATSW}" '"type":"four-stats"'
count=$(printf '%s' "${STATSW}" | grep -o '"title"' | wc -l | tr -d ' ')
assert_eq "stats widget returns exactly four items" "${count}" "4"

# umbrelOS runs `widgetData.refresh = ms(widgetData.refresh)` on every widget
# response, and ms@2 throws on undefined — a widget without this field is
# permanently broken, not merely slow. Check every response shape, including
# the degraded ones served while the node is still starting.
if node - "${BASE}" <<'NODEEOF'
const base = process.argv[2];
// ms@2's accepted grammar, transcribed from its regex.
const MS_RE = /^-?(?:\d+)?\.?\d+ *(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;
const paths = ['/api/widget/sync', '/api/widget/stats'];
(async () => {
  let bad = 0;
  for (const p of paths) {
    const body = await (await fetch(base + p)).json();
    const r = body.refresh;
    const okType = (typeof r === 'string' && r.length > 0 && MS_RE.test(r)) ||
                   (typeof r === 'number' && Number.isFinite(r));
    if (!okType) { console.error(`${p}: refresh is ${JSON.stringify(r)} — ms() would throw`); bad++; }
  }
  process.exit(bad ? 1 : 0);
})();
NODEEOF
then
  ok "both widgets return a refresh value ms() accepts"
else
  bad "both widgets return a refresh value ms() accepts"
fi

# The manifest's refresh values are metadata; the response is what umbreld uses.
# They should still agree, or the desktop and the widget disagree on cadence.
for w in sync:5s stats:10s; do
  name="${w%%:*}"; want="${w##*:}"
  got=$(curl -s "${BASE}/api/widget/${name}" | grep -o "\"refresh\":\"[^\"]*\"" | cut -d'"' -f4)
  if [[ "${got}" == "${want}" ]]; then
    ok "${name} widget refresh matches the manifest (${want})"
  else
    bad "${name} widget refresh matches the manifest" "manifest ${want}, response ${got}"
  fi
done

# The dashboard must degrade gracefully, not crash, when the node disappears.
info "Stopping dogecoind to test degraded behaviour"
"${WORK}/bin/bin/dogecoin-cli" -datadir="${DATADIR}" -conf="${CONF}" stop >/dev/null 2>&1 || true
stopped=0
for _ in $(seq 1 20); do
  if ! curl -sf -o /dev/null --max-time 2 --user "${RPC_USER}:${RPC_PASSWORD}" \
      --data '{"jsonrpc":"1.0","id":"t","method":"getbestblockhash","params":[]}' \
      "http://127.0.0.1:${RPC_PORT}/"; then stopped=1; break; fi
  sleep 1
done
if [[ ${stopped} -eq 1 ]]; then
  ok "dogecoind actually stopped before the degraded checks"
else
  bad "dogecoind actually stopped before the degraded checks" "still answering on ${RPC_PORT}"
fi
DOGE_PID=""

code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/status")
assert_eq "status returns 503 when the node is down" "${code}" "503"
assert_eq "the dashboard itself stays up"            "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")" "200"
DEGRADED="$(curl -s "${BASE}/api/widget/sync")"
assert_contains "sync widget degrades instead of erroring" "${DEGRADED}" '"progressLabel":"Connecting"'
DEGRADED2="$(curl -s "${BASE}/api/widget/stats")"
# Key on a marker only the degraded response carries. '"four-stats"' appears in
# the healthy response too, so it cannot tell the two apart.
assert_contains "stats widget degrades instead of erroring" "${DEGRADED2}" '"text":"Starting"'

# The degraded responses are the ones most likely to forget `refresh`, and they
# are exactly what a user sees while the node is still starting.
if node - "${BASE}" <<'NODEEOF'
const base = process.argv[2];
const MS_RE = /^-?(?:\d+)?\.?\d+ *(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;
(async () => {
  let bad = 0;
  for (const p of ['/api/widget/sync', '/api/widget/stats']) {
    const body = await (await fetch(base + p)).json();
    const r = body.refresh;
    const okType = (typeof r === 'string' && r.length > 0 && MS_RE.test(r)) ||
                   (typeof r === 'number' && Number.isFinite(r));
    if (!okType) { console.error(`${p} (degraded): refresh is ${JSON.stringify(r)}`); bad++; }
  }
  process.exit(bad ? 1 : 0);
})();
NODEEOF
then
  ok "degraded widgets also return a refresh ms() accepts"
else
  bad "degraded widgets also return a refresh ms() accepts"
fi

if kill -0 "${UI_PID}" 2>/dev/null; then ok "dashboard process survived the node going away"; else bad "dashboard process survived the node going away"; fi

# ---------------------------------------------------------------------------
echo
TOTAL=$((PASS + FAIL + SKIP))
if [[ ${TOTAL} -ne ${EXPECTED_CHECKS} ]]; then
  red "Expected ${EXPECTED_CHECKS} checks, accounted for ${TOTAL} (${PASS} pass, ${FAIL} fail, ${SKIP} skip)."
  red "A check disappeared without reporting — treat that as a failure."
  exit 1
fi
if [[ ${FAIL} -eq 0 ]]; then
  green "${PASS} checks passed, 0 failed${SKIP:+, ${SKIP} skipped}"
  exit 0
else
  red "${PASS} passed, ${FAIL} FAILED, ${SKIP} skipped"
  exit 1
fi
