#
# Solo mining stratum server for Dogecoin.
# Zero npm dependencies — Node.js standard library only, including the scrypt
# proof-of-work, which comes from node:crypto rather than a native module.

FROM node:22-alpine

LABEL org.opencontainers.image.title="Dogecoin Solo Mining" \
      org.opencontainers.image.description="Stratum server that mines directly against your own Dogecoin node" \
      org.opencontainers.image.licenses="MIT"

# su-exec drops privileges after the entrypoint has fixed ownership of the
# statistics volume; tini reaps zombies and forwards signals.
# hadolint ignore=DL3018
RUN apk add --no-cache tini su-exec

WORKDIR /app
COPY src/ /app/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    STRATUM_PORT=3333 \
    STATS_PATH=/data/stats.json

EXPOSE 3000 3333

# Starts as root only long enough to chown the statistics directory, then runs
# as uid 1000. Everything else — the read-only root filesystem, cap_drop: ALL,
# no-new-privileges — is set in docker-compose.yml.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/server.js"]
