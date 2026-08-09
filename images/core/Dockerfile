#
# Dogecoin Core — built from the OFFICIAL release binaries published by the
# Dogecoin Core developers, verified against the SHA256 sums that are GPG-signed
# in SHA256SUMS.asc of the release.
#
# Nothing is pulled from third-party images.

ARG DEBIAN_VERSION=bookworm-slim
ARG DOGECOIN_VERSION=1.14.9

# ---------------------------------------------------------------------------
# Stage 1: download + verify + extract
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION} AS builder

# pipefail matters here: the checksum is verified through a pipe.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DOGECOIN_VERSION
ARG TARGETARCH

# SHA256 sums taken verbatim from
# https://github.com/dogecoin/dogecoin/releases/download/v1.14.9/SHA256SUMS.asc
# (PGP-signed by the Dogecoin Core maintainers)
ARG SHA256_AMD64=4f227117b411a7c98622c970986e27bcfc3f547a72bef65e7d9e82989175d4f8
ARG SHA256_ARM64=6928c895a20d0bcb6d5c7dcec753d35c884a471aaf8ad4242a89a96acb4f2985

# Debian package versions are deliberately unpinned: the archive rotates them
# out, and a pinned version turns into an unbuildable image within months. What
# actually matters for reproducibility — the Dogecoin binaries — is pinned by
# SHA256 below.
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    # TARGETARCH is provided by BuildKit; fall back to uname for the classic builder.
    ARCH="${TARGETARCH:-}"; \
    if [ -z "${ARCH}" ]; then \
      case "$(uname -m)" in \
        x86_64) ARCH=amd64 ;; \
        aarch64|arm64) ARCH=arm64 ;; \
        *) ARCH="$(uname -m)" ;; \
      esac; \
    fi; \
    case "${ARCH}" in \
      amd64) DOGE_ARCH="x86_64-linux-gnu";  DOGE_SHA="${SHA256_AMD64}" ;; \
      arm64) DOGE_ARCH="aarch64-linux-gnu"; DOGE_SHA="${SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac; \
    TARBALL="dogecoin-${DOGECOIN_VERSION}-${DOGE_ARCH}.tar.gz"; \
    URL="https://github.com/dogecoin/dogecoin/releases/download/v${DOGECOIN_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 5 --retry-delay 3 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${DOGE_SHA}  /tmp/${TARBALL}" | sha256sum -c -; \
    mkdir -p /opt/dogecoin; \
    tar -xzf "/tmp/${TARBALL}" -C /opt/dogecoin --strip-components=1; \
    rm -f "/tmp/${TARBALL}"; \
    # keep only what we actually need
    rm -rf /opt/dogecoin/bin/dogecoin-qt /opt/dogecoin/bin/test_dogecoin /opt/dogecoin/lib /opt/dogecoin/include; \
    chmod +x /opt/dogecoin/bin/*; \
    /opt/dogecoin/bin/dogecoind --version | head -1

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}

ARG DOGECOIN_VERSION
LABEL org.opencontainers.image.title="Dogecoin Core" \
      org.opencontainers.image.description="Dogecoin Core full node (official binaries) packaged for Umbrel" \
      org.opencontainers.image.version="${DOGECOIN_VERSION}" \
      org.opencontainers.image.source="https://github.com/dogecoin/dogecoin" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gosu openssl libstdc++6 libgcc-s1; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 dogecoin; \
    useradd -u 1000 -g 1000 -m -s /bin/bash dogecoin

COPY --from=builder /opt/dogecoin/bin/ /usr/local/bin/
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENV DOGECOIN_DATA=/data/.dogecoin
VOLUME ["/data"]

# P2P mainnet, RPC mainnet
EXPOSE 22556 22555

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["dogecoind"]
