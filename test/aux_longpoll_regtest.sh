#!/usr/bin/env bash
#
# Fetches Dogecoin Core, starts it in regtest with a wallet, and runs
# test/aux_longpoll_regtest.js against it.
#
# The claims this change rests on are claims about DOGECOIN — that a
# getblocktemplate longpoll wakes on a tip change, that createauxblock caches
# until the tip moves, and that submitauxblock then refuses the old aux block
# with "block hash unknown". Reading that in src/rpc/mining.cpp is how it was
# designed; this is how it is checked.
#
#   ./test/aux_longpoll_regtest.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
DOGE_VERSION="${DOGE_VERSION:-1.14.9}"
RPC_PORT="${RPC_PORT:-23557}"
RPC_USER="umbrel"
RPC_PASSWORD="aux-longpoll-test-password"

cleanup() {
  if [[ -n "${PEER_PID:-}" ]]; then kill "${PEER_PID}" 2>/dev/null || true; fi
  if [[ -n "${DOGE_PID:-}" ]]; then kill "${DOGE_PID}" 2>/dev/null || true; fi
  sleep 1
  rm -rf "${WORK}"
}
trap cleanup EXIT

case "$(uname -m)" in
  x86_64) DOGE_ARCH="x86_64-linux-gnu"; DOGE_SHA="4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8" ;;
  aarch64|arm64) DOGE_ARCH="aarch64-linux-gnu"; DOGE_SHA="6928c895a20d0bcb6d5c7dcec753d35c884a471aaf8ad4242a89a96acb4f2985" ;;
  *) echo "Unsupported test architecture $(uname -m)"; exit 1 ;;
esac

TARBALL="dogecoin-${DOGE_VERSION}-${DOGE_ARCH}.tar.gz"
CACHE="${TMPDIR:-/tmp}/${TARBALL}"
if [[ ! -f "${CACHE}" ]]; then
  curl -fsSL --retry 3 -o "${CACHE}" \
    "https://github.com/dogecoin/dogecoin/releases/download/v${DOGE_VERSION}/${TARBALL}"
fi
# The same checksum the integration suite pins, against the signed SHA256SUMS.
echo "${DOGE_SHA}  ${CACHE}" | sha256sum -c - >/dev/null
mkdir -p "${WORK}/bin" && tar -xzf "${CACHE}" -C "${WORK}/bin" --strip-components=1

# TWO nodes, connected to each other.
#
# Not for the sake of a network, but because Dogecoin Core 1.14.9's
# getblocktemplate refuses outright with "Dogecoin is not connected!" when the
# node has no peers — and, unlike Bitcoin Core, it does NOT exempt regtest from
# that check. createauxblock does exempt it. That asymmetry is invisible on
# mainnet, where the node always has peers, and it is exactly what makes a
# single-node regtest test of this loop impossible.
PEER_P2P="${PEER_P2P:-23558}"
PEER_RPC="${PEER_RPC:-23559}"

DATADIR="${WORK}/data"
PEERDIR="${WORK}/peer"
mkdir -p "${DATADIR}" "${PEERDIR}"
# rpcauth rather than a plaintext password in the config, as the app's own
# entrypoint does — a test that models the deployment badly teaches the wrong
# thing about it.
SALT="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HMAC="$(printf '%s' "${RPC_PASSWORD}" | openssl dgst -sha256 -hmac "${SALT}" -r | cut -d' ' -f1)"
cat > "${DATADIR}/dogecoin.conf" <<EOF
regtest=1
server=1
listen=1
port=${PEER_P2P}
printtoconsole=0
shrinkdebugfile=1
rpcauth=${RPC_USER}:${SALT}\$${HMAC}
rpcallowip=127.0.0.1
rpcbind=127.0.0.1
rpcport=${RPC_PORT}
# The same figure the node app ships, so a blocked longpoll is measured against
# the real thread budget rather than a generous test one.
rpcthreads=8
EOF

cat > "${PEERDIR}/dogecoin.conf" <<EOF
regtest=1
server=1
listen=0
printtoconsole=0
shrinkdebugfile=1
disablewallet=1
connect=127.0.0.1:${PEER_P2P}
rpcuser=peer
rpcpassword=peer
rpcallowip=127.0.0.1
rpcbind=127.0.0.1
rpcport=${PEER_RPC}
EOF

"${WORK}/bin/bin/dogecoind" -datadir="${DATADIR}" -conf="${DATADIR}/dogecoin.conf" -daemon
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --user "${RPC_USER}:${RPC_PASSWORD}" \
      --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:${RPC_PORT}/"; then break; fi
  sleep 1
done
DOGE_PID="$(pgrep -f "dogecoind -datadir=${DATADIR}" | head -1 || true)"

"${WORK}/bin/bin/dogecoind" -datadir="${PEERDIR}" -conf="${PEERDIR}/dogecoin.conf" -daemon
for _ in $(seq 1 60); do
  count=$(curl -s --user "${RPC_USER}:${RPC_PASSWORD}" \
    --data '{"jsonrpc":"1.0","id":"t","method":"getconnectioncount","params":[]}' \
    "http://127.0.0.1:${RPC_PORT}/" | sed 's/.*"result":\([0-9]*\).*/\1/')
  [[ "${count}" == "1" ]] && break
  sleep 1
done
PEER_PID="$(pgrep -f "dogecoind -datadir=${PEERDIR}" | head -1 || true)"

node "${REPO_ROOT}/test/aux_longpoll_regtest.js" "${RPC_PORT}" "${RPC_USER}" "${RPC_PASSWORD}"
