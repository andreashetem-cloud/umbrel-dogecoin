#!/usr/bin/env bash
#
# Build both app images on the Umbrel and make them installable.
#
# Why the local registry: umbrelOS pulls every image in an app's compose file
# from a registry *before* it starts the app (App.install() and App.start() both
# call pull(), and a failed pull aborts the install). A locally-built tag like
# `umbrel-dogecoin-core:1.14.9` resolves to Docker Hub and fails. So we run a
# throwaway registry on 127.0.0.1:5000 — which Docker treats as insecure-allowed
# by default — push the images there, and point the app at it.
#
# This is the "test it on my own Umbrel first" path. To publish the store for
# other people, use the GitHub Actions workflow and then:
#   ./scripts/configure.sh <github-user> umbrel-dogecoin main --registry
#
# Usage, on the Umbrel over SSH:
#   git clone <your repo> ~/umbrel-dogecoin && cd ~/umbrel-dogecoin
#   ./scripts/build-on-umbrel.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${REPO_ROOT}/doge-dogecoin-node/docker-compose.yml"

REGISTRY="${REGISTRY:-127.0.0.1:5000}"
REGISTRY_NAME="${REGISTRY_NAME:-umbrel-local-registry}"
CORE_TAG="${REGISTRY}/umbrel-dogecoin-core:1.14.9"
UI_TAG="${REGISTRY}/umbrel-dogecoin-ui:1.0.0"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — run this on your Umbrel, not on your laptop." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
echo "==> Making sure a local registry is running on ${REGISTRY}"
# ---------------------------------------------------------------------------
if [[ -z "$(docker ps -q --filter "name=^${REGISTRY_NAME}$")" ]]; then
  docker rm -f "${REGISTRY_NAME}" >/dev/null 2>&1 || true
  # restart=always so it is back before umbrelOS starts apps after a reboot.
  docker run -d \
    --name "${REGISTRY_NAME}" \
    --restart always \
    -p 127.0.0.1:5000:5000 \
    -v umbrel-local-registry-data:/var/lib/registry \
    registry:2 >/dev/null
  echo "    started ${REGISTRY_NAME}"
else
  echo "    already running"
fi

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://${REGISTRY}/v2/" && break
  sleep 1
done
curl -sf -o /dev/null "http://${REGISTRY}/v2/" || {
  echo "The local registry never came up on ${REGISTRY}." >&2
  exit 1
}

# ---------------------------------------------------------------------------
echo "==> Building ${CORE_TAG}"
echo "    (downloads the official Dogecoin Core binaries and verifies their SHA256)"
# ---------------------------------------------------------------------------
docker build --tag "${CORE_TAG}" --file "${REPO_ROOT}/images/core/Dockerfile" "${REPO_ROOT}/images/core"

echo "==> Building ${UI_TAG}"
docker build --tag "${UI_TAG}" --file "${REPO_ROOT}/images/ui/Dockerfile" "${REPO_ROOT}/images/ui"

echo "==> Pushing both images into the local registry"
docker push "${CORE_TAG}"
docker push "${UI_TAG}"

# ---------------------------------------------------------------------------
echo "==> Pointing the app at ${REGISTRY}"
# ---------------------------------------------------------------------------
sed -i.bak -E \
  -e "s|image: [^[:space:]]*umbrel-dogecoin-core:|image: ${REGISTRY}/umbrel-dogecoin-core:|" \
  -e "s|image: [^[:space:]]*umbrel-dogecoin-ui:|image: ${REGISTRY}/umbrel-dogecoin-ui:|" \
  "${COMPOSE}"
rm -f "${COMPOSE}.bak"
grep -n "image:" "${COMPOSE}"

cat <<EOF

Done.

Next:
  1. Commit and push this change, so the app store repo umbrelOS clones has the
     ${REGISTRY} image references in it:

       git commit -am "Use the local registry" && git push

  2. In umbrelOS: App Store -> "..." (top right) -> Community App Stores ->
     add your repo URL, then install "Dogecoin Node".

  3. Or from the CLI:

       sudo umbreld client apps.install.mutate --appId doge-dogecoin-node

Keep the ${REGISTRY_NAME} container running — umbrelOS pulls from it on every
app start, including after a reboot.

One caveat worth knowing: if umbrelOS ever has to recover a broken app
environment it runs a cleanup that stops and REMOVES every container on the
box, which takes the registry with it (--restart always does not survive a
docker rm). If an install or update then fails at the pull step, just re-run
this script. Moving to GHCR with ./scripts/configure.sh ... --registry removes
that failure mode entirely.
EOF
