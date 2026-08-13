#!/usr/bin/env bash
# Sourced by umbrelOS before this app starts, and before docker-compose.yml is
# rendered.
#
# WHY THIS FILE EXISTS
#
# umbrelOS regenerates app-data/<app>/docker-compose.yml from the app store on
# every install and every update. Anything typed into the running copy — the
# payout address, the merged-mining switch, the Litecoin RPC password — is
# therefore lost the next time the app updates. The failure is quiet in the
# worst way: the app comes back up mining only Dogecoin, or refuses to start,
# hours after the person who changed the setting has stopped watching.
#
# umbrelOS does NOT create or overwrite app-data/<app>/.env. So that file is
# where device-specific settings belong, and this script is what carries them
# into the environment that renders the compose file. The compose file reads
# them as ${PAYOUT_ADDRESS:-} and friends.
#
# It is also the only place a Litecoin RPC password can live without ending up
# in a git repository.
#
# Example ~/umbrel/app-data/doge-dogecoin-solo/.env:
#
#     PAYOUT_ADDRESS=D...
#     MERGED_MINING=1
#     LTC_PAYOUT_ADDRESS=L...
#     LTC_RPC_PASSWORD=...
#
# Keys not listed in ALLOWED below are ignored on purpose. This file is sourced
# into umbrelOS's own shell while it starts apps: a stray PATH= or
# APP_DOGECOIN_NODE_RPC_PASS= line in a hand-edited .env must not be able to
# reach into that shell, and `set -a; . .env` would let it.

_solo_env_file=""
for _candidate in \
  "${APP_DATA_DIR:-}/.env" \
  "${UMBREL_ROOT:-}/app-data/doge-dogecoin-solo/.env" \
  "${HOME:-/home/umbrel}/umbrel/app-data/doge-dogecoin-solo/.env" \
  "/home/umbrel/umbrel/app-data/doge-dogecoin-solo/.env"; do
  # The leading /.env case: an unset APP_DATA_DIR must not match "/.env".
  if [ "${_candidate}" != "/.env" ] && [ -f "${_candidate}" ]; then
    _solo_env_file="${_candidate}"
    break
  fi
done

if [ -n "${_solo_env_file}" ]; then
  while IFS= read -r _line || [ -n "${_line}" ]; do
    # Tolerate CRLF: a file written on Windows or pasted through a terminal
    # otherwise yields an address with a trailing carriage return, which fails
    # base58 validation with a message that points nowhere near the cause.
    _line="${_line%$'\r'}"
    case "${_line}" in
      ''|'#'*) continue ;;
      export\ *) _line="${_line#export }" ;;
    esac
    _key="${_line%%=*}"
    _value="${_line#*=}"
    # A line without '=' leaves key and value identical; skip it.
    [ "${_key}" = "${_line}" ] && continue
    # Trim surrounding whitespace on the key only. Values are taken verbatim
    # apart from one layer of matching quotes, because a payout address with a
    # space in it is a typo we want the app to reject loudly, not one this
    # script silently repairs.
    _key="${_key#"${_key%%[![:space:]]*}"}"
    _key="${_key%"${_key##*[![:space:]]}"}"
    case "${_value}" in
      \"*\") _value="${_value#\"}"; _value="${_value%\"}" ;;
      \'*\') _value="${_value#\'}"; _value="${_value%\'}" ;;
    esac
    case "${_key}" in
      PAYOUT_ADDRESS|MINING_PROFILE|MERGED_MINING|POLL_INTERVAL_SECONDS|LTC_RPC_HOST|LTC_RPC_PORT|LTC_RPC_USER|LTC_RPC_PASSWORD|LTC_PAYOUT_ADDRESS)
        export "${_key}=${_value}"
        ;;
      *) : ;;
    esac
  done < "${_solo_env_file}"
fi

unset _solo_env_file _candidate _line _key _value
