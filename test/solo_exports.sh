#!/usr/bin/env bash
#
# doge-dogecoin-solo/exports.sh — the device-local .env loader.
#
# This script is what makes the app's settings survive an umbrelOS app update:
# umbrelOS rewrites docker-compose.yml from the app store every time, and reads
# ${PAYOUT_ADDRESS:-} and friends out of the environment this script builds.
# If it silently exports nothing, merged mining turns itself off on the next
# update and the app comes back Dogecoin-only — the exact failure it exists to
# prevent, and one nobody notices until they look at the log.
#
# Every check here runs the real file in a real shell.

set -uo pipefail

EXPORTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/doge-dogecoin-solo/exports.sh"

pass=0
fail=0
ok()  { printf '  \033[32m✓ %s\033[0m\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31m✗ %s\033[0m%s\n' "$1" "${2:+ — $2}"; fail=$((fail + 1)); }

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi
}

# Runs exports.sh against a temporary app-data directory and prints one
# variable. Deliberately spawns a fresh bash each time: a leaked export from a
# previous case would otherwise make the next one pass for the wrong reason.
run_with_env() { # env_file_contents var_name -> value on stdout
  local dir contents var
  contents="$1"; var="$2"
  dir="$(mktemp -d)"
  printf '%s' "${contents}" > "${dir}/.env"
  APP_DATA_DIR="${dir}" bash -c '
    set -euo pipefail
    # shellcheck disable=SC1090
    source "$1"
    printf "%s" "${!2-<unset>}"
  ' _ "${EXPORTS}" "${var}"
  rm -rf "${dir}"
}

echo
echo "the basics"
check "a plain key is exported" \
  "DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd" \
  "$(run_with_env 'PAYOUT_ADDRESS=DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd
' PAYOUT_ADDRESS)"

check "several keys in one file" \
  "1|L123|home" \
  "$(run_with_env 'MERGED_MINING=1
LTC_PAYOUT_ADDRESS=L123
MINING_PROFILE=home
' MERGED_MINING)|$(run_with_env 'MERGED_MINING=1
LTC_PAYOUT_ADDRESS=L123
MINING_PROFILE=home
' LTC_PAYOUT_ADDRESS)|$(run_with_env 'MERGED_MINING=1
LTC_PAYOUT_ADDRESS=L123
MINING_PROFILE=home
' MINING_PROFILE)"

check "a password containing = and / survives intact" \
  'a=b/c+d==' \
  "$(run_with_env 'LTC_RPC_PASSWORD=a=b/c+d==
' LTC_RPC_PASSWORD)"

echo
echo "formatting people actually produce"
check "comments are ignored" "<unset>" \
  "$(run_with_env '# PAYOUT_ADDRESS=DoNotUse
' PAYOUT_ADDRESS)"

check "blank lines are ignored" "Dabc" \
  "$(run_with_env '

PAYOUT_ADDRESS=Dabc

' PAYOUT_ADDRESS)"

check "an export prefix is accepted" "Dabc" \
  "$(run_with_env 'export PAYOUT_ADDRESS=Dabc
' PAYOUT_ADDRESS)"

check "double quotes are stripped" "Dabc" \
  "$(run_with_env 'PAYOUT_ADDRESS="Dabc"
' PAYOUT_ADDRESS)"

check "single quotes are stripped" "Dabc" \
  "$(run_with_env "PAYOUT_ADDRESS='Dabc'
" PAYOUT_ADDRESS)"

# A CRLF file is what you get from a Windows editor or some terminal pastes.
# Without the strip, the address carries a \r and base58 validation fails with
# "address checksum is wrong (typo?)" — pointing the reader at the wrong thing.
crlf="$(run_with_env "$(printf 'PAYOUT_ADDRESS=Dabc\r\n')" PAYOUT_ADDRESS)"
check "a CRLF line ending is stripped" "Dabc" "${crlf}"

check "a file without a trailing newline still parses" "Dabc" \
  "$(run_with_env 'PAYOUT_ADDRESS=Dabc' PAYOUT_ADDRESS)"

check "whitespace around the key is tolerated" "Dabc" \
  "$(run_with_env '   PAYOUT_ADDRESS=Dabc
' PAYOUT_ADDRESS)"

echo
echo "what it must NOT do"
# The allowlist is the point: this script is sourced into umbrelOS's own shell
# while it starts apps. A .env that could set PATH, or overwrite the Dogecoin
# node's derived RPC password, would reach far outside this app.
check "PATH in .env is ignored" "<unset>" \
  "$(run_with_env 'PATH=/tmp/evil
' EVIL_MARKER)"
path_now="$(run_with_env 'PATH=/tmp/evil
' PATH)"
if [[ "${path_now}" == "/tmp/evil" ]]; then
  bad "PATH is not overwritten" "PATH became /tmp/evil"
else
  ok "PATH is not overwritten"
fi

check "another app's RPC password cannot be forged" "<unset>" \
  "$(run_with_env 'APP_DOGECOIN_NODE_RPC_PASS=hunter2
' APP_DOGECOIN_NODE_RPC_PASS)"

check "a line without = is skipped rather than exported" "<unset>" \
  "$(run_with_env 'PAYOUT_ADDRESS
' PAYOUT_ADDRESS)"

# Command substitution in a value must stay literal. `set -a; . .env` would
# execute it; this loader must not.
subst="$(run_with_env 'PAYOUT_ADDRESS=$(touch /tmp/solo_exports_pwned)
' PAYOUT_ADDRESS)"
if [[ -e /tmp/solo_exports_pwned ]]; then
  bad "a command substitution in .env is not executed" "the file was created"
  rm -f /tmp/solo_exports_pwned
else
  ok "a command substitution in .env is not executed"
fi
check "and it is passed through verbatim" '$(touch /tmp/solo_exports_pwned)' "${subst}"

echo
echo "when there is no .env at all"
# umbrelOS sources this on every app start, including the very first one, when
# no .env exists yet. It must not fail, and it must not leave junk behind.
missing="$(APP_DATA_DIR=/nonexistent/definitely-not-here bash -c '
  set -euo pipefail
  source "$1"
  printf "%s|%s" "${PAYOUT_ADDRESS-<unset>}" "${_solo_env_file-<unset>}"
' _ "${EXPORTS}" 2>&1)"
check "no .env: no variables, no error, no leftovers" "<unset>|<unset>" "${missing}"

# The loop variables must not escape either: umbrelOS sources this file into a
# shell that goes on to start other apps.
leftovers="$(APP_DATA_DIR=/nonexistent bash -c '
  set -euo pipefail
  source "$1"
  printf "%s%s%s" "${_line-}" "${_key-}" "${_candidate-}"
' _ "${EXPORTS}")"
check "loop variables are unset afterwards" "" "${leftovers}"

echo
if [[ ${fail} -eq 0 ]]; then
  printf '\033[32m%d checks passed, 0 failed\033[0m\n' "${pass}"
else
  printf '\033[31m%d passed, %d FAILED\033[0m\n' "${pass}" "${fail}"
fi
exit $((fail == 0 ? 0 : 1))
