# Dogecoin Node — Umbrel Community App Store

A Dogecoin Core full node for umbrelOS, with a dashboard for sync status, peers and RPC connection
details. Built from the **official Dogecoin Core release binaries** (v1.14.9), verified against the
SHA256 sums that are PGP-signed by the Dogecoin Core maintainers in
[`SHA256SUMS.asc`](https://github.com/dogecoin/dogecoin/releases/tag/v1.14.9). No third-party images.

```
umbrel-dogecoin/
├── umbrel-app-store.yml          store manifest (store id: "doge")
├── doge-dogecoin-node/           the app
│   ├── umbrel-app.yml            listing, widgets, backup rules
│   ├── docker-compose.yml        dogecoind + dashboard + app_proxy
│   ├── exports.sh                derives a device-unique RPC password
│   ├── icon.svg
│   └── gallery/
├── images/
│   ├── core/                     Dockerfile + entrypoint for dogecoind
│   └── ui/                       Dockerfile + source for the dashboard
├── scripts/
│   ├── configure.sh              point the store at your GitHub repo
│   ├── build-on-umbrel.sh        build both images on the Umbrel itself
│   └── mock-rpc.js               fake dogecoind, for UI development
├── test/
│   ├── entrypoint.sh             56 checks on config generation + healthcheck
│   ├── integration.sh            55 end-to-end checks against a real node
│   └── validate_manifest.py      umbrelOS packaging rules
└── .github/workflows/            tests, multi-arch build, GHCR publish
```

---

## Getting it running on your Umbrel

Before you start: you need a GitHub account, and roughly **200 GB of free disk** on the Umbrel. The
chain is ~150 GB today and grows.

umbrelOS pulls every image in an app's compose file **from a registry before it starts the app** —
`App.install()` and `App.start()` both call `pull()`, and a failed pull aborts the install. A plain
locally-built tag therefore never works. So the flow below builds the images on your Umbrel and pushes
them into a throwaway registry running on `127.0.0.1:5000`, which Docker treats as insecure-allowed by
default. No GitHub Container Registry, no waiting on CI. (To publish for other people later, see
*Publishing*.)

### 1. Put this repo on GitHub and point the store at it

umbrelOS reads a community store straight from a git repo, and it uses the `icon` and `gallery` values
from `umbrel-app.yml` **verbatim** — they must be absolute URLs, so they have to point at your repo.

Create an empty **public** repository on GitHub called `umbrel-dogecoin` (public is far simpler; a
private one means putting credentials on your Umbrel). Then, from this folder on your own machine:

```bash
git init -b main                       # skip if this is already a git repo
./scripts/configure.sh <your-github-username>
git remote add origin https://github.com/<your-github-username>/umbrel-dogecoin.git
git add -A && git commit -m "Configure store URLs" && git push -u origin main
```

`configure.sh` rewrites the icon, gallery, repo and support URLs and re-runs the manifest validator.
If your default branch is not `main`, pass it: `./scripts/configure.sh <user> umbrel-dogecoin master`.

### 2. Build the images on the Umbrel

SSH in (`ssh umbrel@umbrel.local`, password = your umbrelOS password):

```bash
git clone https://github.com/<your-github-username>/umbrel-dogecoin.git ~/umbrel-dogecoin
cd ~/umbrel-dogecoin && chmod +x scripts/*.sh
./scripts/build-on-umbrel.sh
```

This starts the local registry, downloads the official Dogecoin Core tarball for your CPU architecture,
verifies its SHA256 against the hash pinned in the Dockerfile, builds both images, pushes them into the
registry, and points `docker-compose.yml` at it. A few minutes.

The compose file in this repo already refers to `127.0.0.1:5000`, so on a fresh clone that last rewrite
usually changes nothing and `git commit` will say *nothing to commit* — that is the expected outcome,
not a failure. Only if the script did change something do you need:

```bash
git commit -am "Use the local registry" && git push
```

(Pushing from the Umbrel over HTTPS needs a GitHub personal access token and a
`git config --global user.email/user.name`. If you would rather not set that up on the box, make the
change on your own machine and `git pull` here.)

Keep the `umbrel-local-registry` container running — umbrelOS pulls from it on every app start,
including after a reboot. It is created with `--restart always` for exactly that reason.

One caveat: if umbrelOS ever has to recover a broken app environment it runs a cleanup that stops and
**removes every container on the box**, which takes the registry with it (`--restart always` does not
survive a `docker rm`). If a later install or update fails at the pull step, re-run
`build-on-umbrel.sh`. Publishing to GHCR removes that failure mode entirely.

### 3. Add the store, then install

Both steps are needed, in this order.

**Add the store:** in umbrelOS go to **App Store → ⋯ (top right) → Community App Stores → Add**, and
paste your repo URL. There is no CLI equivalent for this part.

**Install:** click Install on "Dogecoin Node", or from the CLI:

```bash
sudo umbreld client apps.install.mutate --appId doge-dogecoin-node
```

(There is no `~/umbrel/scripts/app` on umbrelOS 1.x — that was the pre-1.0 script. Dropping the app
folder into `~/umbrel/app-stores/` by hand does not work either: umbrelOS only looks at repositories
whose URL it has stored, under a directory name it derives from that URL.)

### 4. Let it sync

Open the app from your umbrelOS dashboard, or go straight to `http://umbrel.local:22550`.

**What working looks like:** within a minute or two the header turns to "Syncing", the peer count climbs
above zero, and the sync card shows a percentage plus a blocks/min rate and a rough time remaining. For
the first few minutes it will say *Downloading block headers…* with a moving bar — that is normal, the
headers arrive before any blocks do.

The first sync downloads and validates the whole chain — around **150 GB**, anywhere from several hours
to a couple of days depending on your disk and connection. It resumes where it left off after a restart.
If you are going to raise `DBCACHE` (see below), do it **before** the initial sync — that is when it
helps.

### Everyday commands

```bash
# Live logs from the node (everything goes to the container log)
sudo docker logs -f --tail 100 doge-dogecoin-node_dogecoind_1

# Logs from the dashboard
sudo docker logs --tail 50 doge-dogecoin-node_app_1

# Restart after changing a setting
sudo umbreld client apps.restart.mutate --appId doge-dogecoin-node

# Pull in changes you pushed to the store repo
sudo umbreld client apps.update.mutate --appId doge-dogecoin-node

# Remove the app (this deletes the blockchain data too)
sudo umbreld client apps.uninstall.mutate --appId doge-dogecoin-node
```

### If the sync seems stuck

- **0 peers for more than a few minutes** — the node cannot reach the network. Check the container log
  for `Failed to open` / socket errors, and check that the Umbrel itself has internet.
- **Percentage frozen but peers look fine** — the dashboard says so explicitly after five minutes
  ("No new blocks for N min"). Usually disk. Check `df -h` on the Umbrel; a full disk stalls the node
  silently.
- **Very slow but moving** — raise `DBCACHE`, and prefer an SSD. On an SD card or a slow USB disk the
  initial sync can take days.
- **Corrupted after an unclean power loss** — set `EXTRA_ARGS: "-reindex"` in the compose file, restart
  once, then remove it again.

Note that umbrelOS backups exclude the blocks and chainstate directories (see `backupIgnore`), so
restoring a backup gives you the app back but re-syncs the chain from scratch. That is deliberate —
backing up 150 GB of publicly available data would be silly.

---

## Security

This is packaged as if it were exposed to a hostile network, because parts of it are.

**Credentials.** The RPC password comes from `derive_entropy` — HMAC-SHA256 over your Umbrel's own seed
— so it is unique to your device, stable across restarts and reinstalls, and never committed anywhere.
It is **not** written into `dogecoin.conf`: the entrypoint stores a salted `rpcauth=` HMAC instead, the
same scheme Bitcoin Core's `rpcauth.py` produces. If Umbrel ever fails to supply one, the entrypoint
generates a 256-bit password and persists it with mode 0600.

**Reachability.** RPC binds inside the container and is published to your LAN with `rpcallowip`
restricted to private ranges. It is never reachable from the internet unless you deliberately forward
the port, which you should not do. P2P (22556) is the port that is safe to forward, and forwarding it
lets other nodes connect to you.

**Wallet off by default.** This is a validating node, so `disablewallet=1` is the default. Every wallet
RPC that isn't exposed is one that can't be abused. Flip `DISABLE_WALLET` to `0` if you need it.

**Containers.** Neither container runs as root at runtime: `dogecoind` drops to uid 1000 via `gosu`,
and the dashboard runs as `node`. Both run with `no-new-privileges` and `cap_drop: ALL` — the node adds
back only the five capabilities it needs to drop privileges and fix data ownership once. The dashboard
has a read-only root filesystem, a read-only mount of the data directory, and an 8 MB tmpfs.

**The credentials endpoint.** Every Umbrel app shares one docker network, so this container is
reachable from every other installed app. `PROXY_AUTH_ADD` only guards traffic that goes *through* the
app proxy, so `/api/credentials` additionally checks the peer address and serves the RPC password only
to our own `app_proxy` container — the thing that actually enforces the umbrelOS login. Every other
caller gets a 403, and it fails closed if the name will not resolve. The widget and status endpoints
stay open, because umbreld polls them directly.

**Dashboard.** Zero npm dependencies — Node's standard library only, so there is no supply chain to
audit beyond Node itself. It serves `GET`/`HEAD` only, sends a per-request nonce CSP with no
`unsafe-inline`, plus `nosniff`, `no-referrer`, `SAMEORIGIN` and a restrictive `Permissions-Policy`.
It can only call a fixed allowlist of six read-only RPC methods, caps RPC response bodies at 16 MB,
and keeps the RPC password out of the five-second status poll (it lives behind `/api/credentials`).
Everything sits behind umbrelOS's own login via `PROXY_AUTH_ADD`.

**Supply chain.** The Dockerfile downloads the official release tarball and refuses to build unless the
SHA256 matches the value pinned from the maintainers' PGP-signed `SHA256SUMS.asc`. The tarball's own
`SHA256SUMS.asc` signature was checked when those hashes were pinned; verify it yourself with
`gpg --verify` if you'd rather not take my word for it.

---

## Configuration

Everything is environment variables in `docker-compose.yml`. Bad values fail loudly at startup rather
than silently doing the wrong thing.

The live copy umbrelOS runs is `~/umbrel/app-data/doge-dogecoin-node/docker-compose.yml`, not the one in
this repo. Two things happen to it that are worth knowing:

- umbrelOS **overwrites it from the store repo on every app update** (`docker-compose.yml`, `exports.sh`,
  `*.template`, `torrc`, `hooks/` and `umbrel-app.yml` are all on the update whitelist).
- On **every start** umbrelOS parses and re-serialises it through js-yaml to inject `container_name`.
  That is harmless, but it strips all the comments and renames the YAML anchor — so the live file will
  not look like the one in this repo.

So the durable place to change a setting is the repo: edit, commit, push, and update the app. Editing the
live copy works until the next update. Then restart:

```bash
sudo umbreld client apps.restart.mutate --appId doge-dogecoin-node
```


| Variable | Default | What it does |
|---|---|---|
| `DBCACHE` | `450` | MB of RAM for the UTXO cache. Raising this to `2000`+ is the single biggest initial-sync speed-up. |
| `MAXCONNECTIONS` | `64` | Maximum peer connections. |
| `MAXUPLOADTARGET` | `0` | Daily upload cap in MiB. `0` = unlimited. |
| `MAXMEMPOOL` | `300` | Mempool cap in MB. |
| `PAR` | `0` | Script verification threads. `0` = auto. |
| `PRUNE` | `0` | `0` keeps the full chain. Or e.g. `20000` for a ~20 GB pruned node — it can no longer serve historical blocks. Minimum 550. |
| `TXINDEX` | `0` | `1` builds a full transaction index (needed by block explorers). Rejected together with `PRUNE`. |
| `DISABLE_WALLET` | `1` | `0` enables the wallet and its RPCs. |
| `PEERBLOOMFILTERS` | `0` | `1` serves BIP37 SPV clients — a privacy and DoS trade-off. |
| `TOR_ENABLED` | `0` | `1` routes outbound peer connections through Umbrel's Tor proxy. |
| `TOR_ONLY` | `0` | `1` disables clearnet entirely. Much slower initial sync, maximum privacy. |
| `TOR_PROXY_IP` | from umbrelOS | Umbrel's Tor SOCKS proxy. Required when `TOR_ENABLED=1`; the node refuses to start without it. |
| `TOR_PROXY_PORT` | `9050` | Port of that proxy. |
| `PROXY` | empty | Explicit SOCKS5 proxy, used when `TOR_ENABLED=0`. |
| `RPC_USER` | `umbrel` | RPC username. Letters, digits, dot, dash and underscore only. |
| `RPC_ALLOW_IP` | private ranges | Comma-separated CIDRs allowed to reach the RPC. |
| `ONLYNET` | empty | e.g. `onion`, `ipv4`. |
| `EXTRA_ARGS` | empty | Any extra `dogecoind` flags. |

For anything without a variable, drop a `dogecoin-custom.conf` into
`~/umbrel/app-data/doge-dogecoin-node/data/.dogecoin/` — it is appended to the generated config on every
start. Do not edit `dogecoin.conf` itself; it is regenerated each time the container starts.

There is deliberately no "edit settings from the web UI" feature. It would mean giving a network-facing
process write access to the node's configuration, and the trade isn't worth it for settings you change
once.

## Connecting wallets and other apps

| | |
|---|---|
| RPC from another Umbrel app | `doge-dogecoin-node_dogecoind_1:22555` |
| RPC from your LAN | `umbrel.local:22555` |
| P2P | port `22556` |
| Username / password | on the dashboard, under **Connect a wallet or app** |

---

## Testing

```bash
./test/entrypoint.sh     # 56 checks
./test/integration.sh    # 55 checks
```

`entrypoint.sh` is the one that matters most, because the entrypoint is where a mistake is both most
likely and most expensive — a wrong config line means the node comes up with the wrong security posture
and nothing complains. It runs the real entrypoint against a stubbed `dogecoind`/`gosu` and checks every
branch: that the plaintext password never reaches `dogecoin.conf` or the container log, that the
`rpcauth` line is well formed and its salt is fresh on every start while the password itself survives a
restart, that the file modes are 0600, that bad input (non-numeric values, `PRUNE` below dogecoind's
minimum, `PRUNE` together with `TXINDEX`, an `RPC_USER` containing shell metacharacters) is rejected
rather than silently accepted, that the Tor and pruning switches produce the right config lines, and
that `dogecoin-custom.conf` is appended last so your settings win. Then it hands the generated config to
a real dogecoind and confirms the node starts on it, accepts the password, 401s a wrong one, and really
has no wallet RPCs — plus that the healthcheck says healthy while it runs and unhealthy once it stops.

`integration.sh` downloads Dogecoin Core, verifies the checksum, boots a real node in regtest, runs the
dashboard against it and asserts 55 things — that `rpcauth` accepts the right password and 401s the wrong one, that wallet
RPCs really are gone, that every RPC the app calls actually exists on this build, that the CSP
nonce rotates per request, that the status response never contains the password, and that everything
degrades gracefully instead of crashing when the node goes away, and that a peer which isn't the app
proxy cannot get the password. No Docker needed.

`test/validate_manifest.py` separately checks the packaging against umbrelOS's real rules: the folder
name must equal the manifest `id`, the id must carry the store prefix, `APP_HOST` must be
`<app-id>_<service>_1`, widget endpoint hosts must be compose service names, widget types must be ones
umbrelOS actually renders, icon and gallery must be absolute URLs, and `backupIgnore` paths must pass
umbrelOS's path validation.

It also asks `docker compose` to validate the compose file, with the `app_proxy` image stubbed the way
umbrelOS merges it in at runtime, and it checks something that is easy to get wrong and impossible to
notice: umbrelOS runs `ms(widgetData.refresh)` on every widget response, and `ms` **throws** on
`undefined` — a widget that omits `refresh` from its response body is permanently broken, not merely
slow. Both widgets are asserted to return a value `ms` accepts, matching the manifest.

CI runs all of this plus shellcheck, hadolint and a real multi-arch image build on every push. The
strict packaging check lives in the publish workflow, where it actually gates something: an
unconfigured store, or one still pointing at a local registry, will not be published.

The suites also guard against themselves. Both count their checks and fail if one silently disappears,
`assert_not_contains` fails rather than passes on an empty response, and each input-validation case
asserts on the specific error message so that a crash for an unrelated reason cannot masquerade as a
successful rejection.

---

## Publishing

1. Push to GitHub. `.github/workflows/build-images.yml` builds both images for `linux/amd64` and
   `linux/arm64` and pushes them to GitHub Container Registry.
2. Make both packages public in your GitHub package settings.
3. Point the app at them: `./scripts/configure.sh <your-username> umbrel-dogecoin main --registry`.
   That replaces the `127.0.0.1:5000` references, so the store works for people who have never run
   `build-on-umbrel.sh`. `python3 test/validate_manifest.py --strict` fails while any local-registry or
   placeholder reference is left, which is the gate to run before you share the URL.

Anyone can then add your repo URL as a community app store with nothing to build on their side.

To submit to the **official** Umbrel App Store, open a PR against
[getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps). Their review expects images pinned by
digest (`image: ghcr.io/…@sha256:…`), an `id` without the store prefix (rename the folder and the `id`
field together to `dogecoin-node`), and `gallery: []` with the `icon` field omitted — Umbrel hosts those
assets itself in `umbrel-apps-gallery`.

## Upgrading Dogecoin Core

When a new release lands: bump `DOGECOIN_VERSION` and the two `SHA256_*` build args in
`images/core/Dockerfile` using the values from that release's signed `SHA256SUMS.asc`, bump the image
tag in `docker-compose.yml` and `version` in `umbrel-app.yml`, then run `./test/integration.sh` — it
re-checks that every RPC the dashboard uses still exists on the new build.

## Development

```bash
node scripts/mock-rpc.js &                              # fake dogecoind on :22555
RPC_HOST=127.0.0.1 RPC_PASSWORD=x node images/ui/src/server.js
open http://localhost:3000
```

## Licence

MIT for the packaging in this repo. Dogecoin Core itself is MIT-licensed by the Dogecoin Core
developers. Unofficial community package; not affiliated with the Dogecoin Foundation or Umbrel.
