#!/usr/bin/env bash
#
# Point the app store at YOUR GitHub repo.
#
# umbrelOS uses the icon and gallery values from umbrel-app.yml verbatim for
# community app stores, so they must be absolute URLs — repo-relative paths do
# not work. This script fills them in.
#
#   ./scripts/configure.sh <github-user-or-org> [repo-name] [branch]
#
# Optionally also switch the app from locally-built images to published GHCR
# images (only do this after the GitHub Actions workflow has pushed them):
#
#   ./scripts/configure.sh <github-user> umbrel-dogecoin main --registry
#
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-umbrel-dogecoin}"
BRANCH="${3:-main}"
USE_REGISTRY=0
for arg in "$@"; do
  [[ "${arg}" == "--registry" ]] && USE_REGISTRY=1
done

if [[ -z "${OWNER}" || "${OWNER}" == --* ]]; then
  cat >&2 <<'USAGE'
Usage: ./scripts/configure.sh <github-user-or-org> [repo-name] [branch] [--registry]

Example:
  ./scripts/configure.sh andreas umbrel-dogecoin main
  ./scripts/configure.sh andreas umbrel-dogecoin main --registry
USAGE
  exit 1
fi

if [[ ! "${OWNER}" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; then
  echo "'${OWNER}' does not look like a GitHub username or organisation." >&2
  exit 1
fi

# Without this, `configure.sh me --registry` silently takes "--registry" as the
# repository name and writes it into every URL in the manifest.
for slot in "${2:-}" "${3:-}"; do
  if [[ "${slot}" == --* ]]; then
    echo "Unexpected flag '${slot}' where a repo name or branch was expected." >&2
    echo "Usage: $0 <github-user> [repo-name] [branch] [--registry]" >&2
    exit 1
  fi
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${REPO_ROOT}/doge-dogecoin-node"
MANIFEST="${APP_DIR}/umbrel-app.yml"
COMPOSE="${APP_DIR}/docker-compose.yml"
OWNER_LC="$(printf '%s' "${OWNER}" | tr '[:upper:]' '[:lower:]')"
RAW_BASE="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}"

# Replace both the placeholder and any previously configured owner/repo, so the
# script is safe to run more than once.
python3 - "$MANIFEST" "$OWNER" "$REPO" "$BRANCH" <<'PY'
import re, sys
path, owner, repo, branch = sys.argv[1:5]
raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}"
web = f"https://github.com/{owner}/{repo}"
text = open(path, encoding="utf-8").read()
text = re.sub(r"https://raw\.githubusercontent\.com/[^/]+/[^/]+/[^/]+", raw, text)
text = re.sub(r"https://github\.com/(?!dogecoin/)[^/\s]+/[^/\s]+", web, text)
open(path, "w", encoding="utf-8").write(text)
PY

echo "Manifest URLs now point at ${RAW_BASE}"
grep -nE "^(icon|repo|support|submission):|^  - https" "${MANIFEST}"

if [[ "${USE_REGISTRY}" == "1" ]]; then
  sed -i.bak \
    -E \
    -e "s|image: [^[:space:]]*umbrel-dogecoin-core:|image: ghcr.io/${OWNER_LC}/umbrel-dogecoin-core:|" \
    -e "s|image: [^[:space:]]*umbrel-dogecoin-ui:|image: ghcr.io/${OWNER_LC}/umbrel-dogecoin-ui:|" \
    "${COMPOSE}"
  rm -f "${COMPOSE}.bak"
  echo
  echo "Images now pulled from GHCR:"
  grep -n "image:" "${COMPOSE}"
  echo
  echo "Make both packages public at https://github.com/${OWNER}?tab=packages"
  echo "and consider pinning digests before sharing the store:"
  echo "  docker buildx imagetools inspect ghcr.io/${OWNER_LC}/umbrel-dogecoin-core:1.14.9"
fi

echo
if command -v python3 >/dev/null && python3 -c "import yaml" 2>/dev/null; then
  python3 "${REPO_ROOT}/test/validate_manifest.py"
fi
