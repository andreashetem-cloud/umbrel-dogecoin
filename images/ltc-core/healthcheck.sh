#!/usr/bin/env bash
#
# Healthy = the RPC server answers.
#
# During the first minutes of a start litecoind is still loading the block index
# and answers every RPC with error -28 ("Loading block index…"). That is a
# healthy, expected state — a node with a 100 GB chain can sit there for a
# while — so the warm-up errors count as success, and only a completely
# unreachable RPC endpoint counts as unhealthy.
#
# Authentication: the config carries an rpcauth HMAC rather than a plaintext
# password, so litecoin-cli cannot read credentials out of it. We pass the same
# password the daemon was configured with when it is in the environment, and
# fall back to the daemon's own cookie file otherwise.
#
# The chain (testnet=/regtest=) and the RPC port both come out of the generated
# config, so nothing here needs to be told which network the node is on.
set -uo pipefail

LITECOIN_DATA="${LITECOIN_DATA:-/data/.litecoin}"
DATA_ROOT="${DATA_ROOT:-$(dirname "${LITECOIN_DATA}")}"
CONF="${LITECOIN_DATA}/litecoin.conf"

ARGS=(-datadir="${LITECOIN_DATA}" -conf="${CONF}" -rpcconnect=127.0.0.1)

# Extra flags for unusual runs (the test suite uses this).
if [[ -n "${LITECOIN_CLI_ARGS:-}" ]]; then
  read -ra _extra <<< "${LITECOIN_CLI_ARGS}"
  ARGS+=("${_extra[@]}")
fi

password="${RPC_PASSWORD:-}"
if [[ -z "${password}" && -s "${DATA_ROOT}/rpc-password" ]]; then
  password="$(cat "${DATA_ROOT}/rpc-password")"
fi
if [[ -n "${password}" ]]; then
  ARGS+=(-rpcuser="${RPC_USER:-umbrel}" -rpcpassword="${password}")
fi

output="$(litecoin-cli "${ARGS[@]}" getbestblockhash 2>&1)"
status=$?

if [[ ${status} -eq 0 ]]; then
  exit 0
fi

case "${output}" in
  *"Loading block index"*|*"Verifying blocks"*|*"Rewinding blocks"*|*"Loading wallet"*|\
  *"Activating best chain"*|*"Loading P2P addresses"*|*"warming up"*|*"Starting network threads"*|\
  *"Pruning blockstore"*|*"Replaying blocks"*|*"Loading MWEB"*)
    exit 0
    ;;
esac

echo "${output}" >&2
exit 1
