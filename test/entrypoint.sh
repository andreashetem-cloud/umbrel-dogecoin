#!/usr/bin/env bash
# shellcheck disable=SC2015
#   `cond && ok "…" || bad "…"` is safe here: ok() and bad() are defined below
#   and both always return 0, so the `||` branch can never fire off a
#   successful `ok`.
# shellcheck disable=SC2016
#   One test deliberately passes a literal, unexpanded `$(id)` to prove the
#   entrypoint rejects shell metacharacters in RPC_USER.

#
# Tests images/core/entrypoint.sh — the script that turns environment variables
# into a dogecoin.conf — plus healthcheck.sh, against the real dogecoind binary.
#
# The entrypoint is where a mistake is both most likely and most expensive: a
# wrong config line means the node starts with the wrong security posture and
# nobody notices. So every branch gets exercised, and the config it produces is
# then handed to a real node to prove the node accepts it.
#
# No Docker required: `dogecoind` and `gosu` are stubbed on PATH so the script
# can run to completion without exec'ing anything.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/images/core/entrypoint.sh"
HEALTHCHECK="${REPO_ROOT}/images/core/healthcheck.sh"
WORK="$(mktemp -d)"
DOGE_VERSION="${DOGE_VERSION:-1.14.9}"
NODE_RPC_PORT="${NODE_RPC_PORT:-24555}"

PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); green "  ✓ $1"; }
bad()   {
  FAIL=$((FAIL + 1))
  red "  ✗ $1"
  if [[ $# -gt 1 ]]; then printf '      %s\n' "$2"; fi
  return 0
}

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [[ -n "${NODE_DATADIR:-}" && -f "${NODE_DATADIR}/dogecoin.conf" ]]; then
    "${BIN}/dogecoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/dogecoin.conf" \
      -regtest -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1 || true
    sleep 2
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Stubs: a fake dogecoind that records its argv, and a gosu that just execs.
# ---------------------------------------------------------------------------
STUB="${WORK}/stub"
mkdir -p "${STUB}"

cat > "${STUB}/dogecoind" <<'EOS'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "Dogecoin Core Daemon version v1.14.9"
  exit 0
fi
printf '%s\n' "$*" > "${ARGV_LOG:-/dev/null}"
exit 0
EOS

cat > "${STUB}/gosu" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$1" > "${GOSU_USER_LOG:-/dev/null}"
shift
exec "$@"
EOS

chmod +x "${STUB}/dogecoind" "${STUB}/gosu"

# Run the real entrypoint in an isolated fake /data.
# usage: run_entrypoint <case-name> [VAR=value ...]
run_entrypoint() {
  local name="$1"; shift
  CASE_DIR="${WORK}/${name}"
  mkdir -p "${CASE_DIR}/.dogecoin"
  CASE_OUT="${CASE_DIR}.log"
  CASE_ARGV="${CASE_DIR}.argv"
  CASE_USER="${CASE_DIR}.user"
  env -i \
    PATH="${STUB}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME=/root \
    ARGV_LOG="${CASE_ARGV}" \
    GOSU_USER_LOG="${CASE_USER}" \
    DOGECOIN_DATA="${CASE_DIR}/.dogecoin" \
    DATA_ROOT="${CASE_DIR}" \
    "$@" \
    bash "${ENTRYPOINT}" dogecoind > "${CASE_OUT}" 2>&1
  CASE_STATUS=$?
  CASE_CONF="${CASE_DIR}/.dogecoin/dogecoin.conf"
  return 0
}

conf() { cat "${CASE_CONF}" 2>/dev/null; }
has()  { grep -qxF "$1" "${CASE_CONF}" 2>/dev/null; }

# Every assertion below first insists the config exists. Without this a crashed
# entrypoint makes every "does not contain" check pass for the wrong reason.
conf_exists() {
  if [[ -f "${CASE_CONF}" ]]; then return 0; fi
  bad "$1" "no config was generated (entrypoint exited ${CASE_STATUS})"
  return 1
}

assert_conf_has() {
  conf_exists "$1" || return 0
  if has "$2"; then ok "$1"; else bad "$1" "'$2' not in generated config:$(printf '\n%s' "$(conf)")"; fi
}
assert_conf_lacks() {
  conf_exists "$1" || return 0
  if has "$2"; then bad "$1" "'$2' should not be in the config"; else ok "$1"; fi
}

# ===========================================================================
info "Defaults"
# ===========================================================================
run_entrypoint default RPC_PASSWORD=super-secret-password
[[ ${CASE_STATUS} -eq 0 ]] && ok "entrypoint exits 0" || bad "entrypoint exits 0" "status ${CASE_STATUS}: $(cat "${CASE_OUT}")"

assert_conf_has  "server mode is on"                 "server=1"
assert_conf_has  "listens for inbound peers"         "listen=1"
assert_conf_has  "logs to the container log"         "printtoconsole=1"
assert_conf_has  "debug.log is shrunk on start"      "shrinkdebugfile=1"
assert_conf_has  "wallet disabled by default"        "disablewallet=1"
assert_conf_has  "RPC bound inside the container"    "rpcbind=0.0.0.0"
assert_conf_has  "P2P port"                          "port=22556"
assert_conf_has  "RPC port"                          "rpcport=22555"
assert_conf_has  "private RPC range 10/8"            "rpcallowip=10.0.0.0/8"
assert_conf_has  "private RPC range 192.168/16"      "rpcallowip=192.168.0.0/16"
assert_conf_lacks "no public rpcallowip"             "rpcallowip=0.0.0.0/0"
# Dogecoin Core's defaults (4 threads, queue of 16) are exhausted by a single
# getblocktemplate longpoll, which the solo mining app holds open permanently.
# Every other RPC caller then gets "Work queue depth exceeded".
assert_conf_has  "RPC threads raised above the default of 4" "rpcthreads=8"
assert_conf_has  "RPC work queue raised above the default"   "rpcworkqueue=64"
assert_conf_lacks "pruning off by default"           "prune=0"
assert_conf_lacks "txindex off by default"           "txindex=1"
assert_conf_lacks "bloom filters off by default"     "peerbloomfilters=1"
assert_conf_lacks "no proxy by default"              "proxyrandomize=1"

if grep -q "super-secret-password" "${CASE_CONF}"; then
  bad "the plaintext password never reaches dogecoin.conf"
else
  ok "the plaintext password never reaches dogecoin.conf"
fi
if grep -q "^rpcauth=umbrel:[0-9a-f]\{32\}\$[0-9a-f]\{64\}$" "${CASE_CONF}"; then
  ok "config carries a well-formed salted rpcauth line"
else
  bad "config carries a well-formed salted rpcauth line" "$(grep '^rpcauth' "${CASE_CONF}")"
fi
if grep -q "super-secret-password" "${CASE_OUT}"; then
  bad "the password is never printed to the container log"
else
  ok "the password is never printed to the container log"
fi
[[ "$(stat -c %a "${CASE_CONF}")" == "600" ]] \
  && ok "dogecoin.conf is mode 0600" \
  || bad "dogecoin.conf is mode 0600" "got $(stat -c %a "${CASE_CONF}")"
[[ "$(cat "${CASE_USER}" 2>/dev/null)" == "dogecoin" ]] \
  && ok "dogecoind is started as the unprivileged user" \
  || bad "dogecoind is started as the unprivileged user" "gosu user: $(cat "${CASE_USER}" 2>/dev/null)"
if grep -q -- "-datadir=" "${CASE_ARGV}" && grep -q -- "-conf=" "${CASE_ARGV}"; then
  ok "dogecoind is invoked with an explicit datadir and conf"
else
  bad "dogecoind is invoked with an explicit datadir and conf" "$(cat "${CASE_ARGV}")"
fi
# Umbrel supplied the password, so nothing plaintext should be left on disk.
[[ ! -f "${CASE_DIR}/rpc-password" ]] \
  && ok "no plaintext secret on disk when Umbrel supplies the password" \
  || bad "no plaintext secret on disk when Umbrel supplies the password"

# ===========================================================================
info "Generated password lifecycle"
# ===========================================================================
run_entrypoint generated
[[ ${CASE_STATUS} -eq 0 ]] && ok "starts without a supplied password" || bad "starts without a supplied password" "$(cat "${CASE_OUT}")"
SECRET="${CASE_DIR}/rpc-password"
if [[ -s "${SECRET}" ]]; then
  ok "a password is generated and persisted"
  [[ "$(stat -c %a "${SECRET}")" == "600" ]] \
    && ok "the persisted secret is mode 0600" \
    || bad "the persisted secret is mode 0600" "got $(stat -c %a "${SECRET}")"
  len=$(wc -c < "${SECRET}" | tr -d ' ')
  [[ "${len}" -eq 64 ]] \
    && ok "the generated password is 256 bits" \
    || bad "the generated password is 256 bits" "got ${len} hex chars"
  FIRST="$(cat "${SECRET}")"
  FIRST_AUTH="$(grep '^rpcauth=' "${CASE_CONF}")"

  # Restarting must reuse the same password (otherwise every wallet breaks)
  # while rotating the salt.
  CASE_DIR="${WORK}/generated"
  env -i PATH="${STUB}:/usr/bin:/bin" HOME=/root \
    ARGV_LOG=/dev/null GOSU_USER_LOG=/dev/null \
    DOGECOIN_DATA="${CASE_DIR}/.dogecoin" DATA_ROOT="${CASE_DIR}" \
    bash "${ENTRYPOINT}" dogecoind > "${CASE_DIR}.log2" 2>&1
  RESTART_STATUS=$?
  if [[ ${RESTART_STATUS} -eq 0 ]]; then
    ok "the entrypoint runs cleanly a second time"
  else
    bad "the entrypoint runs cleanly a second time" "$(cat "${CASE_DIR}.log2")"
  fi
  SECOND="$(cat "${SECRET}")"
  SECOND_AUTH="$(grep '^rpcauth=' "${CASE_DIR}/.dogecoin/dogecoin.conf")"
  [[ "${FIRST}" == "${SECOND}" ]] \
    && ok "a restart reuses the persisted password" \
    || bad "a restart reuses the persisted password"
  [[ "${FIRST_AUTH}" != "${SECOND_AUTH}" ]] \
    && ok "the rpcauth salt is fresh on every start" \
    || bad "the rpcauth salt is fresh on every start"
else
  bad "a password is generated and persisted"
fi

# ===========================================================================
info "Input validation"
# ===========================================================================
# Asserting only on a non-zero exit is not enough: the entrypoint could be
# failing for a completely unrelated reason and every one of these would still
# look green. Each case must produce ITS OWN error message.
expect_fail() {
  local name="$1"; local expected="$2"; shift 2
  run_entrypoint "reject-$(echo "${name}" | tr -cd 'A-Za-z0-9')" RPC_PASSWORD=x "$@"
  if [[ ${CASE_STATUS} -eq 0 ]]; then
    bad "${name}" "entrypoint accepted it"
  elif grep -qF "${expected}" "${CASE_OUT}"; then
    ok "${name}"
  else
    bad "${name}" "rejected, but not for the expected reason. Wanted '${expected}', got: $(head -2 "${CASE_OUT}")"
  fi
}
expect_fail "rejects a non-numeric DBCACHE" \
  "DBCACHE must be a whole number"                 DBCACHE=lots
expect_fail "rejects a negative-looking PRUNE" \
  "PRUNE must be a whole number"                   PRUNE=-1
expect_fail "rejects a PRUNE below dogecoind's minimum" \
  "at least 550"                                   PRUNE=100
expect_fail "rejects PRUNE together with TXINDEX" \
  "mutually exclusive"                             PRUNE=20000 TXINDEX=1
expect_fail "rejects an RPC_USER with shell characters" \
  "RPC_USER may only contain"                      'RPC_USER=umbrel$(id)'
expect_fail "rejects a non-numeric MAXCONNECTIONS" \
  "MAXCONNECTIONS must be a whole number"          MAXCONNECTIONS=many

# ===========================================================================
info "Optional features"
# ===========================================================================
run_entrypoint pruned RPC_PASSWORD=x PRUNE=20000
assert_conf_has "pruning is written through"   "prune=20000"

run_entrypoint indexed RPC_PASSWORD=x TXINDEX=1
assert_conf_has "txindex is written through"   "txindex=1"

run_entrypoint wallet RPC_PASSWORD=x DISABLE_WALLET=0
assert_conf_lacks "the wallet can be re-enabled" "disablewallet=1"

run_entrypoint tor RPC_PASSWORD=x TOR_ENABLED=1 TOR_PROXY_IP=10.21.21.11 TOR_PROXY_PORT=9050
assert_conf_has "Tor sets a SOCKS proxy"        "proxy=10.21.21.11:9050"
assert_conf_has "Tor sets the onion proxy"      "onion=10.21.21.11:9050"
assert_conf_has "Tor randomises credentials"    "proxyrandomize=1"
assert_conf_lacks "Tor alone does not disable clearnet" "onlynet=onion"

run_entrypoint toronly RPC_PASSWORD=x TOR_ENABLED=1 TOR_ONLY=1 TOR_PROXY_IP=10.21.21.11
assert_conf_has "Tor-only disables clearnet"    "onlynet=onion"

run_entrypoint tormisconfigured RPC_PASSWORD=x TOR_ENABLED=1
if [[ ${CASE_STATUS} -ne 0 ]] && grep -qF "TOR_PROXY_IP is empty" "${CASE_OUT}"; then
  ok "Tor without a proxy address fails loudly"
else
  bad "Tor without a proxy address fails loudly" "$(head -2 "${CASE_OUT}")"
fi

# A user's own settings must survive, and must win by being appended last.
mkdir -p "${WORK}/custom/.dogecoin"
printf 'maxreceivebuffer=8000\n' > "${WORK}/custom/.dogecoin/dogecoin-custom.conf"
run_entrypoint custom RPC_PASSWORD=x
assert_conf_has "dogecoin-custom.conf is appended" "maxreceivebuffer=8000"
if [[ "$(grep -n 'maxreceivebuffer' "${CASE_CONF}" | cut -d: -f1)" -gt \
      "$(grep -n '^dbcache' "${CASE_CONF}" | cut -d: -f1)" ]]; then
  ok "custom settings are appended after the generated ones"
else
  bad "custom settings are appended after the generated ones"
fi

run_entrypoint extraargs RPC_PASSWORD=x EXTRA_ARGS="-reindex -par=2"
if grep -q -- "-reindex" "${CASE_ARGV}" && grep -q -- "-par=2" "${CASE_ARGV}"; then
  ok "EXTRA_ARGS reach dogecoind as separate arguments"
else
  bad "EXTRA_ARGS reach dogecoind as separate arguments" "$(cat "${CASE_ARGV}")"
fi

# ===========================================================================
info "The generated config against a real dogecoind"
# ===========================================================================
# Read the pin out of the Dockerfile itself. Hard-coding it here would mean the
# test validates a copy of the value rather than the one the image is built with.
DOCKERFILE="${REPO_ROOT}/images/core/Dockerfile"
case "$(uname -m)" in
  x86_64) DOGE_ARCH="x86_64-linux-gnu"; SHA_ARG="SHA256_AMD64" ;;
  aarch64|arm64) DOGE_ARCH="aarch64-linux-gnu"; SHA_ARG="SHA256_ARM64" ;;
  *) red "Unsupported architecture $(uname -m)"; exit 1 ;;
esac
DOGE_SHA="$(grep -oP "^ARG ${SHA_ARG}=\K[0-9a-f]{64}" "${DOCKERFILE}" || true)"
if [[ -n "${DOGE_SHA}" ]]; then
  ok "found the ${SHA_ARG} pin in images/core/Dockerfile"
else
  bad "found the ${SHA_ARG} pin in images/core/Dockerfile" "no 64-hex ARG ${SHA_ARG}= line"
  exit 1
fi
DOCKER_VERSION="$(grep -oP '^ARG DOGECOIN_VERSION=\K[0-9.]+' "${DOCKERFILE}" | head -1)"
if [[ "${DOCKER_VERSION}" == "${DOGE_VERSION}" ]]; then
  ok "the Dockerfile builds the version this suite tests (${DOGE_VERSION})"
else
  bad "the Dockerfile builds the version this suite tests" "Dockerfile ${DOCKER_VERSION}, suite ${DOGE_VERSION}"
fi
TARBALL="dogecoin-${DOGE_VERSION}-${DOGE_ARCH}.tar.gz"
CACHE="${TMPDIR:-/tmp}/${TARBALL}"
if [[ ! -f "${CACHE}" ]]; then
  curl -fsSL --retry 3 -o "${CACHE}" \
    "https://github.com/dogecoin/dogecoin/releases/download/v${DOGE_VERSION}/${TARBALL}"
fi
if echo "${DOGE_SHA}  ${CACHE}" | sha256sum -c - >/dev/null 2>&1; then
  ok "the real tarball matches the SHA256 pinned in the Dockerfile"
else
  bad "the real tarball matches the SHA256 pinned in the Dockerfile" \
      "Dockerfile pins ${DOGE_SHA}, tarball is $(sha256sum "${CACHE}" | cut -d" " -f1)"
fi

mkdir -p "${WORK}/real" && tar -xzf "${CACHE}" -C "${WORK}/real" --strip-components=1
BIN="${WORK}/real/bin"

# Generate a config with the real entrypoint, then start a real node on it.
NODE_DATADIR="${WORK}/realdata/.dogecoin"
mkdir -p "${NODE_DATADIR}"
env -i PATH="${STUB}:/usr/bin:/bin" HOME=/root ARGV_LOG=/dev/null GOSU_USER_LOG=/dev/null \
  DOGECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
  RPC_PASSWORD="real-node-password" RPC_PORT="${NODE_RPC_PORT}" \
  RPC_ALLOW_IP="127.0.0.1" DBCACHE=64 MAXCONNECTIONS=8 \
  EXTRA_ARGS="-regtest -listen=0" \
  bash "${ENTRYPOINT}" dogecoind > "${WORK}/realgen.log" 2>&1

# regtest puts the chain in a subdir, and dogecoind rejects rpcbind without
# rpcallowip, both of which the generated config already handles.
"${BIN}/dogecoind" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/dogecoin.conf" \
  -regtest -listen=0 -daemon >/dev/null 2>&1
started=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null --user "umbrel:real-node-password" \
      --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:${NODE_RPC_PORT}/"; then started=1; break; fi
  sleep 1
done
[[ ${started} -eq 1 ]] \
  && ok "a real dogecoind starts on the generated config and accepts the password" \
  || bad "a real dogecoind starts on the generated config" "$(tail -5 "${NODE_DATADIR}/regtest/debug.log" 2>/dev/null)"

code=$(curl -s -o /dev/null -w '%{http_code}' --user "umbrel:not-the-password" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
  "http://127.0.0.1:${NODE_RPC_PORT}/")
[[ "${code}" == "401" ]] \
  && ok "the generated rpcauth rejects a wrong password" \
  || bad "the generated rpcauth rejects a wrong password" "HTTP ${code}"

wallet=$(curl -s --user "umbrel:real-node-password" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getbalance","params":[]}' \
  "http://127.0.0.1:${NODE_RPC_PORT}/")
[[ "${wallet}" == *"Method not found"* ]] \
  && ok "the generated config really does disable the wallet" \
  || bad "the generated config really does disable the wallet" "${wallet:0:120}"

# --- healthcheck ---------------------------------------------------------
if PATH="${BIN}:${PATH}" DOGECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
     RPC_PASSWORD="real-node-password" DOGECOIN_CLI_ARGS="-regtest" \
     bash "${HEALTHCHECK}" >/dev/null 2>&1; then
  ok "healthcheck reports healthy against a running node"
else
  bad "healthcheck reports healthy against a running node"
fi

"${BIN}/dogecoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/dogecoin.conf" \
  -regtest -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1
for _ in $(seq 1 15); do
  curl -sf -o /dev/null --max-time 2 --user "umbrel:real-node-password" \
    --data '{"jsonrpc":"1.0","id":"t","method":"getbestblockhash","params":[]}' \
    "http://127.0.0.1:${NODE_RPC_PORT}/" || break
  sleep 1
done
if PATH="${BIN}:${PATH}" DOGECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
     RPC_PASSWORD="real-node-password" DOGECOIN_CLI_ARGS="-regtest" \
     bash "${HEALTHCHECK}" >/dev/null 2>&1; then
  bad "healthcheck reports unhealthy once the node is gone"
else
  ok "healthcheck reports unhealthy once the node is gone"
fi
NODE_DATADIR=""

# ===========================================================================
echo
if [[ ${FAIL} -eq 0 ]]; then
  green "${PASS} checks passed, 0 failed"
  exit 0
else
  red "${PASS} passed, ${FAIL} FAILED"
  exit 1
fi
