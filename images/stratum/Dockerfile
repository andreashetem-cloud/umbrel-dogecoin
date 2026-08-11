#
# Solo mining stratum server for Dogecoin.
# Zero npm dependencies — Node.js standard library only, including the scrypt
# proof-of-work, which comes from node:crypto rather than a native module.

FROM node:22-alpine

LABEL org.opencontainers.image.title="Dogecoin Solo Mining" \
      org.opencontainers.image.description="Stratum server that mines directly against your own Dogecoin node" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3018
RUN apk add --no-cache tini

WORKDIR /app
COPY src/ /app/

ENV NODE_ENV=production \
    PORT=3000 \
    STRATUM_PORT=3333

EXPOSE 3000 3333

USER node

# The pool holds no state on disk, so an unclean stop costs nothing: at worst a
# miner reconnects and gets a fresh job.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.js"]
