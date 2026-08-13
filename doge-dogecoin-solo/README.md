# Dogecoin Solo Mining

A stratum v1 server that turns your own Dogecoin node into a solo pool of one.
Your miners connect here instead of to a pool; block templates come from your
node, candidate blocks are submitted by your node, and the reward pays to an
address you control.

## What it is not

It is not a pool. There is no share ledger, no payout engine, no database, and
no operator taking a cut. The coinbase of the block *is* the payout. That is
also why there is nothing here to corrupt: the only state is in memory, and
losing it costs you a reconnect.

## Setup

1. Install the Dogecoin Node app first and let it finish syncing. This app
   declares it as a dependency, which is what makes the node's RPC credentials
   available here.
2. Create `~/umbrel/app-data/doge-dogecoin-solo/.env` on the device with a
   Dogecoin address you control:

   ```
   PAYOUT_ADDRESS=D...
   ```

   The app refuses to start without one, and validates the checksum — a typo
   would otherwise mean mining a reward nobody can spend.
3. Point your miners at `stratum+tcp://<your-umbrel-ip>:22557`. Any password.

### Why `.env` and not `docker-compose.yml`

umbrelOS regenerates `app-data/<app>/docker-compose.yml` from the app store on
every install and every update, so a setting typed there survives until the next
update and then vanishes. It never touches `.env`. `exports.sh` reads that file
and hands the values to the compose file, so the same settings come back after
an update instead of reverting to the defaults — which for merged mining means
the difference between still mining two chains in the morning and quietly
mining one.

Recognised keys, all optional except the first:

| Key | Default | What it does |
| --- | --- | --- |
| `PAYOUT_ADDRESS` | — | Dogecoin address for block rewards. Required. |
| `MINING_PROFILE` | `home` | `home` or `rented`; switches every limit at once. |
| `MERGED_MINING` | `0` | `1` to mine Dogecoin and Litecoin from the same hashes. |
| `LTC_PAYOUT_ADDRESS` | — | Litecoin address (`L…`, `M…` or `3…`). Required when merged. |
| `LTC_RPC_PASSWORD` | — | From the Litecoin Node app. Required when merged. |
| `LTC_RPC_HOST` | `doge-litecoin-node_litecoind_1` | Only if your Litecoin node lives elsewhere. |
| `LTC_RPC_PORT` | `9332` | |
| `LTC_RPC_USER` | `umbrel` | |

Anything else in the file is ignored on purpose: `exports.sh` is sourced into
umbrelOS's own shell while it starts apps, so a stray `PATH=` line there must
not be able to reach outside this app.

Put a Dogecoin address in the **username** field and blocks that worker finds
pay to that address instead of the configured one. That is how these small
scrypt ASICs are set up anyway, so they work with their normal configuration.

## Difficulty, and why the numbers look large

Scrypt stratum difficulty is not Bitcoin's. Every piece of scrypt mining
software applies a factor of 2^16, so a share at difficulty *D* costs
`D × 65536` hashes, not `D × 2^32`. This is a convention baked into the miners
themselves, not something a pool chooses:

- cgminer v3.7.2, `set_target()`: `if (opt_scrypt) d64 *= (double)65536;`
- pooler/cpuminer, `stratum_gen_work()`: `diff_to_target(work->target, sctx->job.diff / 65536.0)`
- node-stratum-pool `algoProperties.js`: `scrypt: { multiplier: Math.pow(2, 16) }`
- Miningcore `coins.json`, litecoin and dogecoin: `"shareMultiplier": 65536`

So difficulty 2048 here means roughly one share every 12 seconds from an
11 MH/s device. Vardiff tunes each worker separately; `MIN_DIFFICULTY` and
`MAX_DIFFICULTY` are only the bounds.

Network difficulty, by contrast, is in the ordinary consensus space. The two
must never be mixed, and the code keeps them in separate functions
(`targetFromShareDifficulty` vs `targetFromDifficulty`) for exactly that reason.

## Expectations

Solo mining is a lottery. At 83 MH/s against a ~2.9 PH/s network with one-minute
blocks, the expected wait is roughly 66 years, and the chance of a block in any
given month is about 0.13%. When you do win, you win the entire block — a little
over 10,000 DOGE at the current subsidy. The dashboard shows your real expected
wait rather than a progress bar, because there is no progress: every share
starts the lottery over.

The "distance to a block" ruler shows how close your best share came, on a
logarithmic scale. It is a record of near misses, not a countdown.

## How it is verified

Block construction is the part where a mistake stays invisible until the day it
costs you a block, so it is tested against Dogecoin Core itself rather than
against assumptions:

- `test/mine_regtest.js` builds blocks with this code and has a real dogecoind
  accept them, then checks the coinbase pays the right address for the right
  amount and the block version survived intact.
- `test/stratum_e2e.js` mines through the wire protocol with a miner that
  rebuilds everything from the `mining.notify` parameters alone, so a wrong
  prevhash word-swap or coinbase split fails the test.
- `test/stratum_payout.js` proves a worker with its own payout address is
  notified with, and validated against, the same coinbase — and that the block
  landing on chain is byte-identical to what the miner solved.
- `test/merkle_check.js` reproduces the merkle root of real blocks from their
  txids and compares against the header dogecoind wrote.
- `test/unit.js` checks the share target against cgminer's formula exactly.
- `test/browser_check.js` renders the dashboard in Chromium and fails on any
  console error, CSP violation or horizontal overflow.

## Ports

| Port | What | Forward on your router? |
|---|---|---|
| 22551 | Dashboard, behind the umbrelOS login | No |
| 22557 | Stratum | **No** — anyone who reaches it can mine to their own address using your node's templates |

## Configuration

Everything is environment variables in `docker-compose.yml`. Editing the running
copy under `~/umbrel/app-data/` works but is overwritten on update; change the
repo and update the app to make it stick.

After changing anything, stop and start the app — never restart it. `docker
restart` gives a container 10 seconds and then kills it, ignoring
`stop_grace_period`. That matters much more for the node app than for this one,
but the habit is worth keeping.
