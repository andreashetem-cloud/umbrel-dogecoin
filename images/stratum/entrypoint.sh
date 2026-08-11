#!/bin/sh
#
# Makes the statistics directory writable, then drops to an unprivileged user.
#
# The container root filesystem is read-only and the app runs as uid 1000. The
# statistics volume comes from the host, where umbrelOS creates it as root, so
# without this the very first save fails with EACCES — and the failure is quiet:
# mining continues, but every restart wipes the history.
#
set -eu

STATS_DIR="$(dirname "${STATS_PATH:-/data/stats.json}")"

if [ "$(id -u)" = "0" ]; then
  if [ -d "${STATS_DIR}" ]; then
    # Non-fatal on purpose. A read-only or otherwise unusual mount must not stop
    # the app from mining; the store reports the problem on the dashboard.
    chown -Rh 1000:1000 "${STATS_DIR}" 2>/dev/null \
      || echo "[entrypoint] WARNING: could not take ownership of ${STATS_DIR}; statistics may not persist"
  fi
  exec su-exec 1000:1000 "$@"
fi

# Already unprivileged (someone set `user:` in compose): just run.
exec "$@"
