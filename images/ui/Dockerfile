#
# Dashboard for the Umbrel Dogecoin Node app.
# Zero npm dependencies — Node.js standard library only.

FROM node:22-alpine

LABEL org.opencontainers.image.title="Dogecoin Node Dashboard" \
      org.opencontainers.image.description="Web dashboard + Umbrel widgets for a Dogecoin Core node" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3018
RUN apk add --no-cache tini

WORKDIR /app
COPY src/ /app/

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.js"]
