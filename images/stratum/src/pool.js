'use strict';
//
// The solo pool: template management plus a stratum v1 server.
//
// "Solo" changes the design in one important way. A real pool must account for
// every share because shares determine who gets paid. Here shares are only a
// progress indicator — the block reward goes straight to a coinbase address.
// So there is no database, no payout logic, and no share ledger to corrupt.
// What must be right is the block construction and the moment of submission.
//

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { RpcClient } = require('./rpc');
const { Job, validateShareAsync, EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } = require('./job');
const { MergedJob, LTC_RULES, DOGE_CHAIN_ID } = require('./merged');
const u = require('./util');

const MAX_LINE_BYTES = 16 * 1024;
// How many jobs stay valid. This is not about new blocks — those arrive by
// longpoll and are announced with clean_jobs — but about REBUILDS: the template
// is rebuilt whenever the coinbase value rises, which on a busy mempool is
// every few seconds. At six, a job expired about thirty seconds after it was
// issued, while the pool was still telling miners the older jobs were valid
// (clean_jobs false). Work returning from a proxy or a rented aggregator is
// routinely older than that, and such a share was rejected as "job not found"
// WITHOUT ever being hashed — so a block-winning share would have been thrown
// away unexamined.
//
// Sixty covered ten minutes when the template was polled every five seconds.
// The merged-mining poll now runs every two, which is fast enough to observe
// essentially every rebuild litecoind produces — Core regenerates its template
// at most once every five seconds, so about twelve a minute — and sixty jobs
// would be five minutes again. A hundred and twenty restores the ten.
const JOB_HISTORY = 120;
// How many superseded difficulty targets a client's in-flight work may still be
// judged against.
const RECENT_TARGETS = 4;
// Connection-churn log lines allowed per minute before they are summarised.
const CHURN_LOG_PER_MINUTE = 20;

// Safety limits get defaults here rather than only in the caller. A limit that
// silently becomes `undefined` compares false against everything, which turns
// every ceiling below into no ceiling at all.
const DEFAULT_LIMITS = {
  maxConnections: 64,
  maxConnectionsPerIp: 8,
  maxMessagesPer10s: 300,
  maxPayoutVariants: 16,
  minLongpollIntervalMs: 250,
  handshakeTimeoutMs: 30000,
  pingIntervalMs: 60000,
  difficultyGraceMs: 60000,
  lockPayoutAddress: false,
};

class Pool extends EventEmitter {
  constructor(config, store = null) {
    super();
    this.config = { ...DEFAULT_LIMITS, ...config };
    config = this.config;
    // Optional durable history. Everything below works without it; the pool
    // simply forgets on restart.
    this.store = store;
    this.rpc = new RpcClient(config.rpc);
    // A second client for longpoll: those requests block for up to a minute and
    // must not sit in front of an urgent submitblock.
    this.longpollRpc = new RpcClient({ ...config.rpc, timeout: 120000 });
    // A third for block submission. submitblock fully validates the block
    // before answering, which on a slow disk can take far longer than the
    // 15 seconds that is generous for every other call — and a timeout there
    // would look like a failure when the node is actually accepting it.
    this.submitRpc = new RpcClient({ ...config.rpc, timeout: 180000 });

    // Merged mining, off unless asked for. Everything below this line that
    // reads `this.merged` is dead code in Dogecoin-only mode, which is what
    // this app runs in production: the parent-chain paths are additions beside
    // the existing ones, not modifications of them.
    //
    // In merged mode the roles swap: `this.rpc` (Dogecoin) stops serving
    // templates and only does createauxblock/submitauxblock, while the
    // Litecoin clients below carry the getblocktemplate/longpoll/submitblock
    // traffic — with the same three-client split and for the same reasons.
    this.merged = !!config.mergedMining;
    if (this.merged) {
      if (!config.ltcRpc) throw new Error('merged mining needs ltcRpc connection details');
      this.ltcRpc = new RpcClient(config.ltcRpc);
      this.ltcLongpollRpc = new RpcClient({ ...config.ltcRpc, timeout: 120000 });
      this.ltcSubmitRpc = new RpcClient({ ...config.ltcRpc, timeout: 180000 });
    }

    this.jobs = new Map();
    this.jobCounter = 0;
    this.currentJob = null;
    this.clients = new Map();
    this.clientCounter = 0;
    this.extranonceCounter = crypto.randomBytes(4).readUInt32BE(0);
    this.pingCounter = 0;
    this.nodeLatency = [];
    this.difficultyHistory = [];

    this.chain = 'main';
    this.payoutScript = null;

    this.stats = {
      startedAt: Date.now(),
      accepted: 0,
      rejected: 0,
      blocksFound: 0,
      bestShareDiff: 0,
      bestShareAt: null,
      lastBlock: null,
      lastTemplateAt: null,
      rejectReasons: {},
      blocks: [],
      templateError: null,
    };

    // Seed the live counters from the durable history, so the dashboard shows
    // a continuous story across restarts rather than starting from zero.
    if (this.store) {
      const s = this.store.state;
      this.stats.accepted = s.accepted;
      this.stats.rejected = s.rejected;
      this.stats.rejectReasons = { ...s.rejectReasons };
      this.stats.blocksFound = this.store.blocksFound();
      this.stats.blocks = s.blocks.slice();
      this.stats.bestShareDiff = s.bestShareDiff;
      this.stats.bestShareAt = s.bestShareAt;
      this.stats.firstStartedAt = s.firstStartedAt;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const info = await this.rpc.call('getblockchaininfo');
    this.chain = info.chain === 'test' ? 'test' : info.chain === 'regtest' ? 'regtest' : 'main';

    // Validate the payout address once, loudly, at startup. Discovering a typo
    // after mining a block is not a recoverable situation.
    this.payoutScript = u.addressToScript(this.config.payoutAddress, this.chain);
    this.log(
      `payout address ${this.config.payoutAddress} accepted on ${this.chain} ` +
        `(script ${this.payoutScript.toString('hex')})`
    );

    if (this.merged) await this.startMerged();

    // Guard against a second start() on the same instance. The caller retries
    // on failure, and without this each retry would leave behind another poll
    // timer and another longpoll loop — all of them competing for the node's
    // handful of RPC threads, which is the very thing that makes a submitblock
    // fail later.
    if (this.started) throw new Error('pool already started');
    // stop() sets this; without clearing it here, a Pool that was stopped and
    // started again would have a longpoll loop that exits immediately.
    this.stopped = false;

    await this.refreshTemplate('startup');
    await this.reconcileBlocks();

    // Bind the socket BEFORE arming any background work, so a port clash
    // cannot leave timers running behind a failed start.
    this.server = net.createServer((socket) => this.onConnection(socket));
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        this.server.once('error', onError);
        this.server.listen(this.config.stratumPort, '0.0.0.0', () => {
          this.server.removeListener('error', onError);
          resolve();
        });
      });
    } catch (err) {
      this.server.close();
      this.server = null;
      throw err;
    }

    // Attach the long-lived error handler only once the socket is bound. An
    // EADDRINUSE re-emitted as an 'error' event on an EventEmitter with no
    // listener is thrown, which turns a recoverable port clash into a crash.
    // emitSafely covers the same hazard for later errors.
    this.server.on('error', (err) => this.emitSafely('error', err));

    this.started = true;

    // Sample the combined hashrate once a minute. This is what the dashboard's
    // history charts are drawn from, and it is the only way to see that a
    // miner dropped out at three in the morning.
    this.sampleTimer = setInterval(() => {
      if (!this.store) return;
      let total = 0;
      // Per worker as well, so one board dropping out is visible on its own
      // line instead of as a dip in a combined figure that two other miners
      // are still holding up. Same name key the store uses everywhere else.
      const perWorker = new Map();
      for (const c of this.clients.values()) {
        if (!c.authorized) continue;
        const hr = this.clientHashrate(c);
        total += hr;
        perWorker.set(c.worker, (perWorker.get(c.worker) || 0) + hr);
      }
      const at = Date.now();
      this.store.recordSample(at, total);
      this.store.recordWorkerSamples(at, perWorker);
    }, 60000);
    this.sampleTimer.unref();

    // Every five minutes, not every thirty seconds: the whole file is rewritten
    // each time, and at 30s that is hundreds of megabytes of writes per day for
    // history nobody loses anyway — a block, a clean shutdown and a crash all
    // force an immediate save.
    this.saveTimer = setInterval(() => {
      if (this.store) this.store.save();
    }, 300000);
    this.saveTimer.unref();

    this.pingTimer = setInterval(() => {
      for (const c of this.clients.values()) this.pingClient(c);
    }, this.config.pingIntervalMs);
    this.pingTimer.unref();

    // Skipped while a refresh is still in flight. Without this, a poll every
    // two seconds against a node whose getblocktemplate occasionally takes
    // longer than that stacks refreshes on top of each other, and it is the
    // overlap — not the frequency — that lets an older result land after a
    // newer one (see the ordering guard in onMergedTemplate).
    this.pollTimer = setInterval(() => {
      if (this.refreshInFlight) return;
      this.refreshInFlight = true;
      this.refreshTemplate('poll')
        .catch(() => {})
        .finally(() => { this.refreshInFlight = false; });
    }, this.config.pollIntervalMs);
    this.pollTimer.unref();
    this.longPollLoop();
    this.log(`stratum listening on 0.0.0.0:${this.config.stratumPort}`);
  }

  // The parent chain's half of startup: reachable node, real address, and a
  // Dogecoin daemon that actually speaks the aux RPCs.
  //
  // Every check here refuses to start rather than degrading. A merged pool that
  // silently falls back to one chain looks identical to a working one on the
  // dashboard while half the reward it was configured for is never claimed.
  async startMerged() {
    const info = await this.ltcRpc.call('getblockchaininfo');
    this.ltcChain =
      info.chain === 'regtest' ? 'ltc-regtest' : info.chain === 'test' ? 'ltc-test' : 'ltc-main';

    if (!this.config.ltcPayoutAddress) {
      throw new Error(
        'merged mining is on but LTC_PAYOUT_ADDRESS is not set; the Litecoin block reward has nowhere to go'
      );
    }
    // Deliberately checked against the LITECOIN version bytes. A Dogecoin
    // address decodes cleanly as base58check and would produce a perfectly
    // well-formed script — paying a hash160 nobody on Litecoin has the key
    // for. This is the quietest way to lose a whole block reward.
    this.ltcPayoutScript = u.addressToScript(this.config.ltcPayoutAddress, this.ltcChain);
    this.log(
      `merged mining: parent ${this.ltcChain} paying ${this.config.ltcPayoutAddress} ` +
        `(script ${this.ltcPayoutScript.toString('hex')}), aux Dogecoin paying ${this.config.payoutAddress}`
    );

    // Fail now if dogecoind cannot serve aux blocks — an old build, or one
    // without the wallet — instead of at the first template refresh.
    const probe = await this.rpc.call('createauxblock', [this.config.payoutAddress]);
    if (!probe || !/^[0-9a-f]{64}$/.test(String(probe.hash))) {
      throw new Error('createauxblock did not return an aux block hash');
    }
    // The chain ID the proof is checked against is a constant in merged.js;
    // if the daemon on the other end of this socket is not the chain that
    // constant describes, every proof we build is rejected.
    if (probe.chainid !== DOGE_CHAIN_ID) {
      throw new Error(
        `the aux node reports chain id ${probe.chainid}, not Dogecoin's ${DOGE_CHAIN_ID}`
      );
    }

    // A worker's username address cannot be honoured here. The parent coinbase
    // pays a LITECOIN script, and the aux coinbase is built by dogecoind from
    // the address given to createauxblock — so a Dogecoin address in a username
    // would either be pasted into a Litecoin block or ignored. Lock it, and say
    // so, rather than let the dashboard report a payout that is not happening.
    if (!this.config.lockPayoutAddress) {
      this.config.lockPayoutAddress = true;
      this.log('merged mining: per-worker payout addresses are disabled; both rewards go to the configured addresses');
    }
  }

  // Ask the node about every block we recorded but never resolved.
  //
  // A crash, a power cut or a kill during the submit-retry window leaves a
  // record stuck at "submitting", and a submission that exhausted its retries
  // can still end up on the chain via a peer. Without this, blocksFound — which
  // is derived from these records — undercounts a block you actually mined,
  // permanently and silently.
  async reconcileBlocks() {
    if (!this.store) return;
    const unresolved = this.store.state.blocks.filter(
      (b) => b && b.hash && b.accepted !== true
    );
    if (!unresolved.length) return;

    let resolved = 0;
    for (const b of unresolved) {
      // Ask the chain the block belongs to. Records written before merged mode
      // existed carry no `chain` and are Dogecoin's. Asking dogecoind about a
      // Litecoin hash gets an honest "not found", which would rewrite a good
      // block to "the node does not have this block" on every restart.
      const rpc = b.chain === 'LTC' ? this.ltcRpc : this.rpc;
      if (!rpc) continue;
      try {
        const block = await rpc.call('getblock', [b.hash]);
        // confirmations is -1 for a block the node knows but that is not on the
        // main chain, which is exactly the orphaned case.
        if (block && block.confirmations >= 1) {
          this.store.updateBlock(b.hash, { status: 'accepted', accepted: true, error: null });
          resolved++;
          this.log(`block ${b.height} was on the chain after all — ${b.hash}`);
        } else if (b.status === 'submitting') {
          this.store.updateBlock(b.hash, {
            status: 'stale',
            accepted: false,
            error: 'valid, but another block reached this height first',
          });
        }
      } catch {
        // The node does not have it. If we never finished submitting, say so
        // honestly rather than leaving it as "submitting" forever.
        if (b.status === 'submitting') {
          this.store.updateBlock(b.hash, {
            status: 'error',
            accepted: false,
            error: 'submission was interrupted; the node does not have this block',
          });
        }
      }
    }

    this.store.save(true);
    this.stats.blocks = this.store.state.blocks.slice();
    this.stats.blocksFound = this.store.blocksFound();
    if (resolved) this.log(`reconciled ${resolved} block(s) against the node at startup`);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.sampleTimer);
    clearInterval(this.saveTimer);
    clearInterval(this.pingTimer);
    this.pollTimer = null;
    // Force a final write: an update or a reboot must not cost the last half
    // minute of history.
    if (this.store) this.store.save(true);
    // Ends the longpoll loop; without it an abandoned instance keeps polling
    // the node forever.
    this.stopped = true;
    this.started = false;
    if (this.server) this.server.close();
    for (const c of this.clients.values()) {
      clearTimeout(c.handshakeTimer);
      c.socket.destroy();
    }
  }

  // Stop taking new work, without tearing anything down yet.
  //
  // Order matters at shutdown. Draining while the stratum port is still open
  // means miners keep submitting, the counter never reaches zero, and the drain
  // burns its whole timeout for nothing — after which every share that finishes
  // a moment later is thrown away.
  beginShutdown() {
    this.draining = true;
    if (this.server) {
      try { this.server.close(); } catch { /* already closed */ }
    }
  }

  // Resolves once nothing is in progress, or after `timeoutMs`.
  //
  // This counts BLOCK SUBMISSIONS as well as share validation. Submission is
  // the slow one — six attempts with backoff, up to about two minutes — and it
  // is the only thing here whose loss actually costs money. Exiting while a
  // submitblock retry is pending means the block never reaches the chain.
  async drain(timeoutMs = 130000) {
    const deadline = Date.now() + timeoutMs;
    while (this.pending() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.pending() === 0;
  }

  pending() {
    return (this.inFlight || 0) + (this.inFlightBlocks || 0);
  }

  // Node throws when an 'error' event has no listener. That is a sensible
  // default for application code and a terrible one for a background service,
  // so errors are logged when nobody is listening rather than fatal.
  recordNodeLatency(ms) {
    if (!this.nodeLatency) this.nodeLatency = [];
    this.nodeLatency.push(ms);
    if (this.nodeLatency.length > 20) this.nodeLatency.shift();
  }

  medianNodeLatency() {
    if (!this.nodeLatency || !this.nodeLatency.length) return null;
    const sorted = [...this.nodeLatency].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Round-trip time to a miner. Stratum v1 has no ping, but `client.get_version`
  // is a server-to-client request that firmware answers, which makes it the
  // only honest way to measure the link. Miners that ignore it simply report no
  // latency rather than a made-up number.
  pingClient(client) {
    if (!client.authorized || client.socket.destroyed) return;
    // Random, not sequential: a predictable id lets a client answer a ping it
    // was never sent and report whatever latency flatters it.
    const id = `ping-${crypto.randomBytes(8).toString('hex')}`;
    client.pendingPing = { id, sentAt: Date.now() };
    this.send(client, { id, method: 'client.get_version', params: [] });
    // If the miner never answers, stop claiming we are waiting.
    setTimeout(() => {
      if (client.pendingPing && client.pendingPing.id === id) {
        client.pendingPing = null;
        if (client.supportsGetVersion) {
          // This miner does answer, so silence means the link went quiet —
          // exactly what this number exists to surface. Showing the last good
          // round-trip would hide it.
          client.latencyMs = null;
          client.latencyFrom = null;
        }
        // Firmware that never answers keeps its handshake estimate. Wiping it
        // every 30 seconds is what left this column empty for both of the
        // miners actually connected to this pool.
      }
    }, 15000).unref();
  }

  // Smoothed network difficulty. Dogecoin retargets EVERY block (DigiShield,
  // damped by 1/8), so the instantaneous value swings by tens of percent within
  // minutes. Deriving "expected wait" from a single sample makes that number
  // jump around for no real reason.
  recordNetworkDifficulty(difficulty, prevHash) {
    if (!(difficulty > 0)) return;
    if (!this.difficultyHistory) this.difficultyHistory = [];
    // De-duplicate by tip hash. A reorg swaps the tip back and forth, and
    // without this the same height is sampled twice and skews the mean.
    if (prevHash && this.difficultySeen && this.difficultySeen.has(prevHash)) return;
    if (prevHash) {
      if (!this.difficultySeen) this.difficultySeen = new Set();
      this.difficultySeen.add(prevHash);
      if (this.difficultySeen.size > 200) {
        this.difficultySeen.delete(this.difficultySeen.values().next().value);
      }
    }
    this.difficultyHistory.push(difficulty);
    if (this.difficultyHistory.length > 60) this.difficultyHistory.shift();
  }

  // Null until there is enough history to be worth calling an average. The
  // dashboard falls back to the instantaneous value, which is honest; claiming
  // a "recent average" built from one sample is not.
  smoothedDifficulty() {
    const h = this.difficultyHistory;
    if (!h || h.length < 10) return null;
    return h.reduce((a, b) => a + b, 0) / h.length;
  }

  // Two hazards, not one. Emitting 'error' with no listener THROWS in Node, and
  // a listener that throws propagates into whatever called emit — which on the
  // block path is the code submitting the block. Guarding only the first, which
  // this used to do, left the comments at the call sites promising a protection
  // that did not exist.
  emitSafely(event, payload) {
    if (this.listenerCount(event) === 0) {
      // An unlistened 'error' carries an Error; the block events carry a record.
      // Interpolating an object straight into a template gives "[object
      // Object]", which is exactly the wrong thing to find in a log after a
      // block. Describe what is actually there.
      const detail = payload && payload.message ? payload.message
        : payload && payload.height ? `height ${payload.height} (${payload.hash || 'no hash'})`
        : String(payload);
      this.log(`${event}: ${detail}`);
      return;
    }
    try {
      this.emit(event, payload);
    } catch (err) {
      this.log(`a ${event} listener threw (${err.message}); continuing`);
    }
  }

  log(msg) {
    // eslint-disable-next-line no-console
    console.log(`[pool] ${msg}`);
  }

  // For lines an unauthenticated peer can cause: connections, disconnections,
  // refusals. Connect-and-drop in a loop otherwise writes tens of megabytes a
  // second into the container log, which fills the disk and — worse — pushes
  // out the BLOCK HEX line that is the last resort for recovering a block.
  // Beyond the budget the lines are counted and summarised once a minute.
  churnLog(msg) {
    const now = Date.now();
    if (!this.churnWindowAt || now - this.churnWindowAt >= 60000) {
      if (this.churnSuppressed) {
        this.log(`(${this.churnSuppressed} more connection events in the last minute)`);
      }
      this.churnWindowAt = now;
      this.churnCount = 0;
      this.churnSuppressed = 0;
    }
    if (this.churnCount < CHURN_LOG_PER_MINUTE) {
      this.churnCount++;
      this.log(msg);
    } else {
      this.churnSuppressed = (this.churnSuppressed || 0) + 1;
    }
  }

  // ---------------------------------------------------------------- templates

  async refreshTemplate(reason) {
    if (this.merged) return this.refreshMergedTemplate(reason, null);
    try {
      const askedAt = Date.now();
      const template = await this.rpc.getBlockTemplate();
      // How long your node takes to hand over a template. If this climbs, the
      // node is the bottleneck, not the miners — and a slow template means
      // mining on stale work after somebody else finds a block.
      this.recordNodeLatency(Date.now() - askedAt);
      // Log the recovery, not just the failure. For an unattended run this is
      // the pair of lines that explains a gap in the share history.
      if (this.stats.templateError) {
        this.log(`the Dogecoin node is answering again after ${
          Math.round((Date.now() - (this.stats.templateFailedAt || Date.now())) / 1000)
        }s`);
      }
      this.stats.templateError = null;
      this.stats.templateFailedAt = null;
      this.stats.lastTemplateAt = Date.now();
      this.onTemplate(template, reason);
    } catch (err) {
      // Forget the latency window while the node is unreachable, so the
      // dashboard cannot show a healthy round-trip next to a template error.
      this.nodeLatency = [];
      // Log the FIRST failure of an outage at any severity, then stay quiet so
      // a long outage does not fill the log. Previously a poll failure was
      // silent, so a node that went away left no trace at all.
      if (!this.stats.templateError) {
        this.stats.templateFailedAt = Date.now();
        this.log(`cannot reach the Dogecoin node (${reason}): ${err.message}`);
      }
      this.stats.templateError = err.message;
      throw err;
    }
  }

  // The merged equivalent, kept as a separate function so the Dogecoin-only
  // path above is not made conditional.
  //
  // The two chains are fetched SEPARATELY and fail separately, which matters
  // more than it looks. Litecoin is the chain being hashed: if the parent tip
  // moves and we do not rebuild, every miner keeps working on a header whose
  // previous block is orphaned, and every Litecoin block found in that window
  // is worthless. Dogecoin going away must therefore not stop the parent job
  // from being rebuilt — a stale aux commitment is just opaque bytes to
  // Litecoin, so the last known aux hash is carried forward and only the
  // Dogecoin half is at risk while dogecoind is down.
  //
  // `template` is passed in by the longpoll loop, which has just been handed a
  // fresh one and must not ask for another.
  async refreshMergedTemplate(reason, template) {
    const askedAt = Date.now();
    let parent;
    try {
      parent = template || (await this.ltcRpc.call('getblocktemplate', [{ rules: LTC_RULES }]));
    } catch (err) {
      this.nodeLatency = [];
      this.noteTemplateFailure(`cannot reach the Litecoin node (${reason}): ${err.message}`, err);
      throw err;
    }

    // Polled rather than longpolled: dogecoind has no longpoll for aux blocks.
    // It caches internally and hands back the same block until its own tip or
    // mempool moves, so this is cheap.
    let auxBlock = null;
    try {
      auxBlock = await this.rpc.call('createauxblock', [this.config.payoutAddress]);
      if (this.auxUnavailableSince) {
        this.log(`the Dogecoin node is answering again after ${
          Math.round((Date.now() - this.auxUnavailableSince) / 1000)
        }s`);
      }
      this.auxUnavailableSince = null;
    } catch (err) {
      // Keep mining Litecoin on the last aux commitment we had. A Dogecoin
      // block found now would be refused — dogecoind forgets an aux block once
      // its tip moves — but a Litecoin block found now is worth just as much as
      // ever, and stopping would forfeit both.
      auxBlock = this.currentJob && this.currentJob.auxBlock ? this.currentJob.auxBlock : null;
      if (!this.auxUnavailableSince) {
        this.auxUnavailableSince = Date.now();
        this.log(
          `cannot reach the Dogecoin node (${reason}): ${err.message}` +
            (auxBlock ? '; continuing on Litecoin with the last aux block' : '')
        );
      }
      if (!auxBlock) {
        this.noteTemplateFailure(null, err);
        throw err;
      }
    }

    this.recordNodeLatency(Date.now() - askedAt);
    if (this.stats.templateError) {
      this.log(`the mining nodes are answering again after ${
        Math.round((Date.now() - (this.stats.templateFailedAt || Date.now())) / 1000)
      }s`);
    }
    this.stats.templateError = null;
    this.stats.templateFailedAt = null;
    // Cleared on success as well: without this the next failure is compared
    // against a timestamp from the previous outage and suppressed.
    this.templateLoggedAt = null;
    this.templateLoggedMessage = null;
    this.stats.lastTemplateAt = Date.now();

    // 2: the aux chain being unreachable is NOT a template error — the parent
    // job is fine and Litecoin mining continues — but it must not therefore be
    // invisible. The dashboard shows a Dogecoin height that has stopped moving
    // and everything else green; without this the operator has no way to tell
    // that half the app is dead, and the worst case is a node that answers but
    // is in initial download, where its tip IS moving and every Dogecoin share
    // is doomed.
    this.stats.auxError = this.auxUnavailableSince
      ? `the Dogecoin node has been unreachable for ${
          Math.round((Date.now() - this.auxUnavailableSince) / 1000)
        }s — Litecoin mining continues, Dogecoin blocks cannot be submitted`
      : null;

    this.onMergedTemplate(parent, auxBlock, reason, askedAt);
  }

  // One place to record a template failure, so the "log it once" rule actually
  // holds. The longpoll loop clears templateError before each attempt, so a
  // guard that only checks templateError logged on every iteration — about
  // thirty lines a minute, forever, which is exactly what pushes the BLOCK HEX
  // recovery line out of a rotating container log.
  noteTemplateFailure(message, err) {
    const now = Date.now();
    // Deduped on the MESSAGE as well as on time. Time alone means a flapping
    // node — fail, recover, fail again within the minute — logs the first
    // failure and then goes quiet, leaving "the mining nodes are answering
    // again" as the last line while the node is down at that moment.
    const same = message === this.templateLoggedMessage;
    if (message && (!same || !this.templateLoggedAt || now - this.templateLoggedAt > 60000)) {
      this.templateLoggedMessage = message;
      this.templateLoggedAt = now;
      this.log(message);
    }
    if (!this.stats.templateFailedAt) this.stats.templateFailedAt = now;
    this.stats.templateError = err.message;
  }

  onMergedTemplate(template, auxBlock, reason, askedAt = Date.now()) {
    // Ordering, not just difference.
    //
    // The poll and the longpoll both call this, neither awaits the other, and
    // an RPC that stalls can deliver its answer after a later one has already
    // been applied. `isNewBlock` below tests INEQUALITY of the previous-block
    // hash, so a late answer describing the PREVIOUS tip reads as "new block"
    // and gets installed and broadcast with clean_jobs — putting every miner
    // back on an orphaned parent until the next refresh. Dogecoin submissions
    // would still succeed (Dogecoin never validates the parent chain), so the
    // dashboard would look perfectly healthy while the Litecoin half mined a
    // dead branch.
    //
    // A result that was requested BEFORE the installed job's request and that
    // would move either chain backwards is therefore dropped. A genuine reorg
    // to a lower height still installs: it arrives on a fetch started after
    // the current job's, so the first condition is false.
    if (
      this.currentJob &&
      askedAt < (this.currentJob.fetchedAt || 0) &&
      (template.height < this.currentJob.height ||
        (auxBlock && auxBlock.height < this.currentJob.auxHeight))
    ) {
      return;
    }
    if (template.longpollid) this.lastLongpollId = template.longpollid;

    // EITHER tip moving invalidates the job. The aux hash covers the Dogecoin
    // side: it changes when Dogecoin's tip moves and also when its mempool
    // does, and continuing to commit to a superseded aux block means every
    // Dogecoin block we find is refused.
    const isNewBlock =
      !this.currentJob ||
      this.currentJob.template.previousblockhash !== template.previousblockhash ||
      this.currentJob.auxHash !== auxBlock.hash;

    if (!isNewBlock) {
      const ageMs = Date.now() - this.currentJob.createdAt;
      const gainedValue = template.coinbasevalue > this.currentJob.coinbaseValue;
      if (!gainedValue && ageMs < this.config.jobRebuildMs) return;
    }

    const id = (++this.jobCounter).toString(16).padStart(8, '0');
    const job = new MergedJob(id, template, this.ltcPayoutScript, this.config.coinbaseTag, auxBlock);
    // When this job's data was ASKED for, not when it was built: the ordering
    // guard above compares request times, and a slow RPC would otherwise make
    // a stale answer look newer than the fresh one it overtook.
    job.fetchedAt = askedAt;
    this.jobs.set(id, job);
    this.currentJob = job;
    // Dogecoin's difficulty, keyed on Dogecoin's tip: this is a Dogecoin app,
    // and "expected wait" means the wait for a Dogecoin block.
    if (isNewBlock) this.recordNetworkDifficulty(job.auxDifficulty, auxBlock.previousblockhash);

    while (this.jobs.size > JOB_HISTORY) {
      this.jobs.delete(this.jobs.keys().next().value);
    }

    if (isNewBlock) {
      this.log(
        `new merged job — Dogecoin height ${job.auxHeight} (difficulty ` +
          `${job.auxDifficulty.toFixed(0)}), Litecoin height ${job.height} (difficulty ` +
          `${job.networkDifficulty.toFixed(0)}) (${reason})`
      );
    }

    for (const client of this.clients.values()) {
      if (client.authorized) this.sendJob(client, job, isNewBlock);
    }
  }

  onTemplate(template, reason) {
    // Always record this, even when we decide not to rebuild the job below.
    if (template.longpollid) this.lastLongpollId = template.longpollid;

    const isNewBlock =
      !this.currentJob ||
      this.currentJob.template.previousblockhash !== template.previousblockhash;

    // Without a new block, only rebuild if there is something to gain: more fees
    // in the template, or the job is getting stale. Rebuilding constantly would
    // reset every miner's nonce search for nothing.
    if (!isNewBlock) {
      const ageMs = Date.now() - this.currentJob.createdAt;
      const gainedValue = template.coinbasevalue > this.currentJob.coinbaseValue;
      if (!gainedValue && ageMs < this.config.jobRebuildMs) return;
    }

    const id = (++this.jobCounter).toString(16).padStart(8, '0');
    const job = new Job(id, template, this.payoutScript, this.config.coinbaseTag);
    this.jobs.set(id, job);
    this.currentJob = job;
    if (isNewBlock) this.recordNetworkDifficulty(job.networkDifficulty, template.previousblockhash);

    // Keep a short history so shares still in flight when a job rotates are not
    // thrown away as "job not found".
    while (this.jobs.size > JOB_HISTORY) {
      this.jobs.delete(this.jobs.keys().next().value);
    }

    if (isNewBlock) {
      this.log(
        `new block on the network — height ${job.height}, ` +
          `network difficulty ${job.networkDifficulty.toFixed(0)} (${reason})`
      );
    }

    for (const client of this.clients.values()) {
      if (client.authorized) this.sendJob(client, job, isNewBlock);
    }
  }

  // The job a specific client must be given. A worker that supplied its own
  // payout address mines its own coinbase, so it must be NOTIFIED with that
  // coinbase too — sending one coinbase and validating against another yields a
  // different merkle root and rejects every share the worker submits.
  clientJob(client, job) {
    return client.payoutScript ? this.jobForClient(job, client) : job;
  }

  async longPollLoop() {
    while (!this.stopped) {
      // Track the longpollid from the LATEST template we received, not from the
      // current job. Those diverge: onTemplate deliberately keeps the existing
      // job when a new template brings nothing worth interrupting miners for.
      // Longpolling with a spent id returns instantly, so reading the id off
      // the job turns this loop into an unthrottled hammer on the node's RPC —
      // which is exactly how you exhaust its four worker threads and make every
      // other caller fail with "Work queue depth exceeded".
      const id = this.lastLongpollId;
      if (!id) {
        await sleep(1000);
        continue;
      }
      const startedAt = Date.now();
      try {
        // In merged mode this longpolls LITECOIN — the parent tip is the one
        // that invalidates the header miners are hashing. Dogecoin's tip is
        // caught by the createauxblock poll instead, which is the only
        // mechanism dogecoind offers.
        const template = await (this.merged ? this.ltcLongpollRpc : this.longpollRpc).call(
          'getblocktemplate',
          [{ longpollid: id, rules: this.merged ? LTC_RULES : [] }]
        );
        this.stats.templateError = null;
        this.stats.lastTemplateAt = Date.now();
        if (this.merged) await this.refreshMergedTemplate('longpoll', template);
        else this.onTemplate(template, 'longpoll');
      } catch (err) {
        // A timeout here is normal and expected; anything else deserves a pause
        // so a broken node does not turn into a busy loop.
        if (err.code !== 'ETIMEDOUT') await sleep(2000);
      }
      // Belt and braces: however the call ended, never issue more than a few
      // longpolls per second. A single missed id must not cost the node its
      // RPC capacity.
      const elapsed = Date.now() - startedAt;
      if (elapsed < this.config.minLongpollIntervalMs) {
        await sleep(this.config.minLongpollIntervalMs - elapsed);
      }
    }
  }

  // ------------------------------------------------------------------ clients

  onConnection(socket) {
    // Stratum has no authentication — by design, since there is no account to
    // authenticate against. That makes an unbounded connection count a trivial
    // resource-exhaustion path for anyone on the LAN, so it gets a ceiling.
    if (this.clients.size >= this.config.maxConnections) {
      this.churnLog(`refused a connection from ${socket.remoteAddress}: at the ${this.config.maxConnections}-connection limit`);
      socket.destroy();
      return;
    }

    // A global ceiling alone is not enough: one machine opening bare TCP
    // sockets — sending nothing, so the message rate limit never applies —
    // would take every slot and lock out the real miners. Cap per source too.
    const remote = socket.remoteAddress || 'unknown';
    let fromThisHost = 0;
    for (const c of this.clients.values()) if (c.remote === remote) fromThisHost++;
    if (fromThisHost >= this.config.maxConnectionsPerIp) {
      this.churnLog(`refused a connection from ${remote}: already has ${fromThisHost}`);
      socket.destroy();
      return;
    }

    const id = ++this.clientCounter;
    const extranonce1 = Buffer.alloc(EXTRANONCE1_SIZE);
    extranonce1.writeUInt32BE(this.extranonceCounter++ >>> 0, 0);

    const client = {
      id,
      socket,
      extranonce1,
      subscribed: false,
      authorized: false,
      worker: null,
      payoutAddress: null,
      difficulty: this.config.startDifficulty,
      pendingDifficulty: null,
      connectedAt: Date.now(),
      lastShareAt: null,
      shareTimes: [],
      accepted: 0,
      rejected: 0,
      bestShareDiff: 0,
      // Round-trip time and where it came from. 'ping' is a real measurement
      // from client.get_version; 'handshake' is the subscribe->authorize gap,
      // which every miner produces but which also contains the miner's own
      // processing time, so it is an upper bound and is labelled as such.
      latencyMs: null,
      latencyFrom: null,
      supportsGetVersion: false,
      subscribeRepliedAt: null,
      rejectReasons: {},
      buffer: '',
      rateWindowAt: Date.now(),
      rateCount: 0,
      // The same normalised value the per-IP cap counts, so a socket with no
      // remoteAddress cannot slip past the cap by being counted differently.
      remote,
    };
    this.clients.set(id, client);

    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true);
    socket.setTimeout(this.config.socketTimeoutMs);

    // Defence in depth: anything thrown inside a socket event handler that is
    // not caught takes the whole process down, and this handler parses input
    // from an unauthenticated peer.
    socket.on('data', (chunk) => {
      try {
        this.onData(client, chunk);
      } catch (err) {
        this.log(`dropping connection ${client.id} after an internal error: ${err.message}`);
        socket.destroy();
      }
    });
    socket.on('timeout', () => socket.destroy());

    // A connection that never authorizes is not a miner. Without this, an idle
    // socket holds its slot for the full socket timeout — fifteen minutes by
    // default — and a single newline now and then extends that forever.
    client.handshakeTimer = setTimeout(() => {
      if (!client.authorized) {
        this.log(`dropping connection ${client.id} from ${remote}: never authorized`);
        socket.destroy();
      }
    }, this.config.handshakeTimeoutMs);
    client.handshakeTimer.unref();
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(client.handshakeTimer);
      this.clients.delete(id);
      this.churnLog(`worker disconnected: ${client.worker || 'unauthorized'} (#${id})`);
    });
  }

  onData(client, chunk) {
    client.buffer += chunk.toString('utf8');
    if (client.buffer.length > MAX_LINE_BYTES) {
      // No legitimate stratum message is anywhere near this size.
      client.socket.destroy();
      return;
    }
    const lines = client.buffer.split('\n');
    client.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Rate limit per connection. Share validation runs scrypt, which is
      // deliberately expensive, so an unthrottled client can spend our CPU far
      // faster than it spends its own.
      const now = Date.now();
      if (now - client.rateWindowAt > 10000) {
        client.rateWindowAt = now;
        client.rateCount = 0;
      }
      if (++client.rateCount > this.config.maxMessagesPer10s) {
        this.log(`worker ${client.worker || client.id} exceeded the message rate limit; disconnecting`);
        client.socket.destroy();
        return;
      }

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // JSON.parse happily returns null, a number, a string or an array. Every
      // one of those is a valid line of JSON and none of them is a stratum
      // message. Reading .method or .id off them either throws — taking the
      // whole process down, since this runs inside a socket event handler —
      // or silently does nothing. One line containing `null` was enough.
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        continue;
      }
      const replyId = msg.id === undefined ? null : msg.id;
      try {
        // handleSubmit is async, so a thrown error arrives as a rejected
        // promise that the surrounding try/catch would never see.
        const outcome = this.handleMessage(client, msg);
        if (outcome && typeof outcome.catch === 'function') {
          outcome.catch((err) => {
            this.reply(client, replyId, null, [20, err.message, null]);
          });
        }
      } catch (err) {
        this.reply(client, replyId, null, [20, err.message, null]);
      }
    }
  }

  send(client, obj) {
    if (client.socket.destroyed) return;
    client.socket.write(JSON.stringify(obj) + '\n');
  }

  reply(client, id, result, error = null) {
    this.send(client, { id, result, error });
  }

  handleMessage(client, msg) {
    // A message with no method is a RESPONSE to something we asked, not a
    // request. Without this branch it falls through to "unknown method" and we
    // reply to a reply, which some firmware answers again.
    if (msg.method === undefined) {
      if (client.pendingPing && msg.id === client.pendingPing.id) {
        client.latencyMs = Date.now() - client.pendingPing.sentAt;
        client.latencyFrom = 'ping';
        // Remembered so a later timeout can tell "this miner answers and has
        // gone quiet" (report nothing) from "this miner never answers"
        // (keep the handshake estimate).
        client.supportsGetVersion = true;
        client.pendingPing = null;
      }
      return;
    }

    switch (msg.method) {
      case 'mining.subscribe':
        return this.handleSubscribe(client, msg);
      case 'mining.authorize':
        return this.handleAuthorize(client, msg);
      case 'mining.submit':
        return this.handleSubmit(client, msg);
      case 'mining.extranonce.subscribe':
        return this.reply(client, msg.id, true);
      case 'mining.suggest_difficulty':
        return this.handleSuggestDifficulty(client, msg);
      case 'mining.configure':
        // We support no extensions; an empty object is the correct answer and
        // keeps firmware that always sends this from failing at handshake.
        return this.reply(client, msg.id, {});
      case 'mining.multi_version':
        return this.reply(client, msg.id, true);
      default:
        return this.reply(client, msg.id, null, [20, 'unknown method', null]);
    }
  }

  handleSubscribe(client, msg) {
    client.subscribed = true;
    // Bounded like the worker name: this string is stored, served in the status
    // API and rendered in the dashboard, and it arrives from the network.
    const agent = Array.isArray(msg.params) ? msg.params[0] : null;
    client.userAgent = agent == null ? null : String(agent).slice(0, 128);
    const sub = crypto.randomBytes(8).toString('hex');
    this.reply(client, msg.id, [
      [
        ['mining.set_difficulty', sub],
        ['mining.notify', sub],
      ],
      client.extranonce1.toString('hex'),
      EXTRANONCE2_SIZE,
    ]);
    // Stamped AFTER the write, so the interval measured against the authorize
    // that follows is the link, not our own serialisation.
    client.subscribeRepliedAt = Date.now();
  }

  handleAuthorize(client, msg) {
    // Re-authorizing an established connection would swap the payout script out
    // from under work the miner is already hashing: the coinbase changes, the
    // merkle root changes, and every in-flight share — including a winning one
    // — is validated against a header the miner never built. Accept the call so
    // firmware that repeats it is not upset, but change nothing.
    if (client.authorized) {
      this.reply(client, msg.id, true);
      return;
    }

    // The only round-trip every miner produces. Firmware sends authorize the
    // moment it has our subscribe reply, so this gap is the link plus a little
    // parsing. Both of this user's miners ignore client.get_version, and a
    // permanently empty column is worse than an honest upper bound.
    if (client.subscribeRepliedAt && client.latencyMs == null) {
      const rtt = Date.now() - client.subscribeRepliedAt;
      // Beyond a second the miner was doing something else, not waiting on the
      // network, and the number would be a lie.
      if (rtt >= 0 && rtt <= 1000) {
        client.latencyMs = rtt;
        client.latencyFrom = 'handshake';
      }
    }

    const [username] = msg.params || [];
    // Control characters stripped, not just length-bounded. A name containing a
    // newline lets anyone who can reach this port write forged lines into the
    // container log — including a convincing "BLOCK ACCEPTED" — and the same
    // string is stored and served to the dashboard.
    client.worker = String(username || 'worker')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 64) || 'worker';
    client.authorized = true;
    client.payoutScript = null;
    client.payoutAddress = null;

    // These miners put an address in the username field, so honour it: the
    // block a worker finds pays the address that worker asked for. Anything
    // unparseable silently falls back to the app's configured address rather
    // than refusing to mine.
    //
    // LOCK_PAYOUT_ADDRESS turns this off. Worth setting if the stratum port is
    // reachable by anyone you would not hand a block to — with it on, every
    // block pays the configured address no matter what a worker asks for.
    if (!this.config.lockPayoutAddress) {
      const candidate = client.worker.split('.')[0];
      try {
        const script = u.addressToScript(candidate, this.chain);
        // Decide here whether this address can actually be honoured, and say so
        // if it cannot. Deciding later, per job, meant a worker past the limit
        // silently mined to the app's address while the dashboard and the logs
        // reported the worker's own — the worst possible failure for something
        // that decides who gets paid.
        const key = script.toString('hex');
        const inUse = new Set();
        for (const c of this.clients.values()) {
          if (c !== client && c.payoutScript) inUse.add(c.payoutScript.toString('hex'));
        }
        if (!inUse.has(key) && inUse.size >= this.config.maxPayoutVariants) {
          this.log(
            `worker ${client.worker} asked to be paid at ${candidate}, but the limit of ` +
              `${this.config.maxPayoutVariants} distinct payout addresses is reached; ` +
              `its blocks will pay ${this.config.payoutAddress}`
          );
          client.payoutAddress = null;
          client.payoutScript = null;
        } else {
          client.payoutAddress = candidate;
          client.payoutScript = script;
        }
      } catch {
        // Leave both null so the app's configured address is used. Clearing
        // the script matters: clientJob() keys off it, so a stale one would
        // pay an address the dashboard does not report.
        client.payoutAddress = null;
        client.payoutScript = null;
      }
    }

    this.reply(client, msg.id, true);
    this.churnLog(
      `worker connected: ${client.worker} (#${client.id}) from ${client.remote}` +
        (client.payoutAddress ? ` paying ${client.payoutAddress}` : '')
    );

    this.setDifficulty(client, client.difficulty);
    if (this.currentJob) this.sendJob(client, this.currentJob, true);
  }

  handleSuggestDifficulty(client, msg) {
    const suggested = Number((msg.params || [])[0]);
    if (Number.isFinite(suggested) && suggested > 0) {
      const clamped = clamp(suggested, this.config.minDifficulty, this.config.maxDifficulty);
      this.setDifficulty(client, clamped);
    }
    this.reply(client, msg.id, true);
  }

  setDifficulty(client, difficulty) {
    // Keep the previous target valid for a grace period. A miner applies
    // mining.set_difficulty immediately, but work already dispatched to its
    // ASIC carries the old difficulty and is submitted against it. Rejecting
    // those would show up as a steady stream of "low difficulty share" that
    // looks exactly like failing hardware.
    if (client.target) {
      client.previousTarget = client.target;
      client.previousDifficulty = client.difficulty;
      client.previousTargetUntil = Date.now() + this.config.difficultyGraceMs;
      this.rememberTarget(client, client.target);
    }
    client.difficulty = difficulty;
    // Stratum space, with the scrypt 2^16 multiplier — not consensus space.
    client.target = u.targetFromShareDifficulty(difficulty);
    this.send(client, { id: null, method: 'mining.set_difficulty', params: [difficulty] });
  }

  sendJob(client, job, cleanJobs) {
    this.send(client, {
      id: null,
      method: 'mining.notify',
      params: this.clientJob(client, job).notifyParams(cleanJobs),
    });
  }

  // ------------------------------------------------------------------- shares

  async handleSubmit(client, msg) {
    if (!client.authorized) {
      return this.reply(client, msg.id, null, [24, 'unauthorized worker', null]);
    }
    // Deliberately NOT refused during shutdown. A submission that arrives after
    // beginShutdown() can still be the block, and the drain already waits for
    // work in flight — so validating it costs a moment and refusing it could
    // cost the whole point of the app. Only new CONNECTIONS are turned away.

    const [, jobId, extranonce2, ntime, nonce] = msg.params || [];
    const job = this.jobs.get(jobId);
    if (!job) {
      this.countReject(client, 'stale job');
      return this.reply(client, msg.id, null, [21, 'job not found', null]);
    }

    // Must be the exact same job object the client was notified with.
    const effectiveJob = this.clientJob(client, job);

    // Every target this client has recently been told to use, not just the last
    // one: vardiff can climb several steps within a second on a fast miner, and
    // work queued at the first of them is still legitimately in flight.
    const targets = Date.now() < client.previousTargetUntil
      ? this.recentTargets(client)
      : [client.target];

    // Asynchronous on purpose: scrypt is expensive by design, and anyone who
    // reaches this port can ask for it. Running it on the event loop would let
    // a flood of junk submissions delay the one call that matters — submitblock.
    //
    // The counter lets shutdown wait for work already in progress, so the last
    // share before an update is not the one missing from the history.
    this.inFlight = (this.inFlight || 0) + 1;
    let result;
    try {
      result = await validateShareAsync(effectiveJob, {
        extranonce1: client.extranonce1,
        extranonce2Hex: String(extranonce2 || ''),
        ntimeHex: String(ntime || ''),
        nonceHex: String(nonce || ''),
        shareTarget: targets,
      });
    } finally {
      this.inFlight--;
    }

    // A block is a block even if the miner has gone. Do NOT return early on a
    // dead socket before the candidate check: the scrypt hash runs on the
    // thread pool, and anything that closes the connection in that window — a
    // TCP reset, the rate limiter, a shutdown — would otherwise throw away a
    // solved block. Only the reply to the miner is pointless now.
    const gone = client.socket.destroyed;

    if (!result.ok) {
      if (gone) return;
      this.countReject(client, result.reason);
      return this.reply(client, msg.id, null, [23, result.reason, null]);
    }

    // Submit first. Everything below is bookkeeping, and a block must not
    // depend on it.
    //
    // The two chains are dispatched separately and neither is awaited. One
    // hash can win on both, and a throw, a rejection or a node that is simply
    // down on one side must not cost the block on the other — so each gets its
    // own guard rather than sharing a try.
    if (result.isBlockCandidate) {
      this.dispatchSubmission(
        () => this.submitBlock(effectiveJob, result, client),
        this.merged ? 'Litecoin block submission' : 'block submission'
      );
    }
    if (result.isAuxCandidate) {
      this.dispatchSubmission(
        () => this.submitAuxBlock(effectiveJob, result, client),
        'Dogecoin aux block submission'
      );
    }

    // Count the share even if the socket has gone. The work was done and
    // verified; only the reply to the miner is pointless now. Returning early
    // here would discard exactly the shares a shutdown drain exists to keep.
    client.accepted++;
    this.stats.accepted++;
    const now = Date.now();
    // Record the difficulty the share actually satisfied. During the grace
    // window after an increase, a share may only meet the OLD target; crediting
    // it at the new one would overstate the hashrate and mislead vardiff.
    const metCurrent = result.shareDiff * u.HASHES_PER_SHARE_UNIT >= client.difficulty * 0.99;
    const creditedDifficulty =
      metCurrent || !client.previousDifficulty ? client.difficulty : client.previousDifficulty;
    client.lastShareAt = now;
    client.shareTimes.push({ at: now, difficulty: creditedDifficulty });
    if (client.shareTimes.length > 200) client.shareTimes.shift();

    if (result.shareDiff > client.bestShareDiff) client.bestShareDiff = result.shareDiff;
    if (result.shareDiff > this.stats.bestShareDiff) {
      this.stats.bestShareDiff = result.shareDiff;
      this.stats.bestShareAt = now;
    }
    if (this.store) {
      this.store.recordShare(now, result.shareDiff, creditedDifficulty, client.worker);
    }

    if (gone) return;
    this.reply(client, msg.id, true);
    this.retarget(client);
  }

  // A view of the job carrying a specific payout script. Cached on the JOB and
  // keyed by the script, not per client: ten workers paying the same address
  // share one variant, and the memory cost is bounded by the number of distinct
  // addresses rather than by the number of connections.
  jobForClient(job, client) {
    const key = client.payoutScript.toString('hex');
    if (!job.variants) job.variants = new Map();
    const cached = job.variants.get(key);
    if (cached) return cached;

    // Backstop only — handleAuthorize already refuses to hand out a payout
    // script past the limit, and logs when it does. Reaching this branch would
    // mean a worker mining to the app's address while believing otherwise, so
    // it is loud rather than silent.
    if (job.variants.size >= this.config.maxPayoutVariants) {
      this.log(
        `WARNING: no job variant available for ${client.payoutAddress || 'a worker'}; ` +
          `its work will pay ${this.config.payoutAddress}`
      );
      return job;
    }
    const variant = new Job(job.id, job.template, client.payoutScript, this.config.coinbaseTag);
    job.variants.set(key, variant);
    return variant;
  }

  // Targets this client has recently been given. A single "previous target" is
  // not enough while vardiff is ramping: a rented miner climbs several steps in
  // a couple of seconds, and work already queued at the older difficulty is
  // then judged against a target several steps harder and rejected as a low
  // difficulty share. Keeping a few is honest — the miner really was told to
  // use them — and costs nothing, because share difficulty has no bearing on
  // whether a block is found.
  recentTargets(client) {
    const list = [client.target];
    for (const t of client.previousTargets || []) list.push(t);
    return list;
  }

  rememberTarget(client, target) {
    if (!client.previousTargets) client.previousTargets = [];
    client.previousTargets.unshift(target);
    while (client.previousTargets.length > RECENT_TARGETS) client.previousTargets.pop();
  }

  countReject(client, reason) {
    client.rejected++;
    // Per worker as well as in total: "8 rejected" across the pool does not say
    // which board is producing them, and stale shares from one slow miner need
    // a different answer than bad shares from a failing one.
    if (!client.rejectReasons) client.rejectReasons = {};
    client.rejectReasons[reason] = (client.rejectReasons[reason] || 0) + 1;
    this.stats.rejected++;
    this.stats.rejectReasons[reason] = (this.stats.rejectReasons[reason] || 0) + 1;
    if (this.store) this.store.recordReject(reason, client.worker);
  }

  // A found block is the entire point of the app, and submitblock is a single
  // RPC call that can fail transiently — a timeout while the node validates the
  // block, a full work queue, a restarting node. Failing once must not be the
  // end of it. Resubmitting a block the node already has is harmless: it
  // answers "duplicate", which we treat as success.
  async submitWithRetries(blockHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await this.submitRpc.submitBlock(blockHex);
      } catch (err) {
        lastError = err;
        this.log(
          `submitblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // The aux chain's equivalent. submitauxblock answers with a boolean rather
  // than Core's verdict string, so it is normalised into the same vocabulary
  // the shared machinery below already speaks.
  async submitAuxWithRetries(auxHash, auxPowHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        const ok = await this.submitRpc.call('submitauxblock', [auxHash, auxPowHex]);
        return ok === true ? null : 'dogecoind refused the auxpow proof';
      } catch (err) {
        lastError = err;
        this.log(
          `submitauxblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // Guard a submission that is deliberately not awaited. Without this a
  // rejection from one chain is an unhandled rejection at process level, and a
  // synchronous throw would propagate back into the share handler and abort the
  // other chain's submission before it was ever dispatched.
  dispatchSubmission(fn, what) {
    try {
      const p = fn();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => this.log(`${what} failed: ${err.message}`));
      }
    } catch (err) {
      this.log(`${what} failed: ${err.message}`);
    }
  }

  async submitBlock(job, result, client) {
    this.inFlightBlocks = (this.inFlightBlocks || 0) + 1;
    try {
      await this.submitBlockInner(job, result, client);
    } finally {
      this.inFlightBlocks--;
    }
  }

  async submitAuxBlock(job, result, client) {
    this.inFlightBlocks = (this.inFlightBlocks || 0) + 1;
    try {
      await this.submitAuxBlockInner(job, result, client);
    } finally {
      this.inFlightBlocks--;
    }
  }

  async submitAuxBlockInner(job, result, client) {
    const auxPowHex = job.auxPowHex(result.header, result.coinbase);

    // Check our own proof against Dogecoin's rules before spending the retry
    // schedule on it. The one input here we do not control is extranonce2, and
    // a miner that puts a second merged-mining magic in it makes the proof
    // invalid — which must cost this submission only. The Litecoin block for
    // the same share is already on its way, independently.
    const verdict = job.verifyAgainstDogecoin(result.header, result.coinbase);
    if (!verdict.ok) {
      this.log(
        `NOT submitting the Dogecoin aux block at height ${job.auxHeight}: ${verdict.problems.join(' | ')}`
      );
      return;
    }

    await this.submitCandidate({
      chain: 'DOGE',
      height: job.auxHeight,
      hash: job.auxHash,
      // Not a block: the auxpow proof, which is what recovers this block by
      // hand if everything else fails. Same reasoning as the block hex.
      hex: auxPowHex,
      hexLabel: `AUXPOW HEX chain=DOGE height=${job.auxHeight} auxhash=${job.auxHash}`,
      reward: job.auxValue,
      address: this.config.payoutAddress,
      worker: client.worker,
      submit: () => this.submitAuxWithRetries(job.auxHash, auxPowHex, job.auxHeight),
    });
  }

  async submitBlockInner(job, result, client) {
    // In merged mode this block is the LITECOIN one, and it pays the Litecoin
    // address; a worker's own address is refused at authorize time there.
    const address = this.merged
      ? this.config.ltcPayoutAddress
      : client.payoutAddress || this.config.payoutAddress;
    await this.submitCandidate({
      chain: this.merged ? 'LTC' : 'DOGE',
      height: job.height,
      hash: result.blockHash,
      hex: result.blockHex,
      hexLabel: this.merged
        ? `BLOCK HEX chain=LTC height=${job.height}`
        : `BLOCK HEX height=${job.height}`,
      reward: job.coinbaseValue,
      address,
      worker: client.worker,
      submit: () =>
        this.merged
          ? this.submitLtcWithRetries(result.blockHex, job.height)
          : this.submitWithRetries(result.blockHex, job.height),
    });
  }

  async submitLtcWithRetries(blockHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await this.ltcSubmitRpc.submitBlock(blockHex);
      } catch (err) {
        lastError = err;
        this.log(
          `Litecoin submitblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // Everything between "we hold a winning hash" and "the node has ruled on it",
  // for whichever chain won: the durable record, the hex in the log, the
  // notification, the retries and the verdict. One implementation, because this
  // is the sequence that costs real money when it is subtly different in two
  // places.
  async submitCandidate({ chain, height, hash, hex, hexLabel, reward, address, worker, submit }) {
    // Log lines carry the chain only in merged mode: with merged mining off
    // these are the exact strings this app has always written, and someone
    // grepping a year of container logs should not have to know that.
    const where = this.merged ? `${chain} height ${height}` : `height ${height}`;
    const what = this.merged ? `${chain} block` : 'block';
    this.log(`BLOCK CANDIDATE at ${where} by ${worker} — ${hash}`);
    const record = {
      // Which chain this block is on. Without it the dashboard shows two
      // records at unrelated heights and reconciliation asks the wrong node.
      chain,
      height,
      hash,
      worker,
      address,
      reward,
      at: Date.now(),
      status: 'submitting',
      accepted: null,
      error: null,
    };
    this.stats.blocks.unshift(record);
    if (this.stats.blocks.length > 50) this.stats.blocks.pop();

    // The full block hex, FIRST — before the store, before any listener, before
    // the submission. A dying SD card can hold fsync for tens of seconds or
    // forever, and this line is the difference between a recoverable situation
    // and 10,000 DOGE gone. It must not depend on a disk that may be failing.
    console.log(`[pool] ${hexLabel} ${hex}`);

    if (this.store) {
      // The store keeps a copy WITHOUT the block hex: fifty mainnet blocks of
      // hex is tens of megabytes, and the file is serialised synchronously.
      //
      // Saved here, before the submission, and deliberately so.
      //
      // Deferring it to a setImmediate after the submit call looks like it
      // takes the fsync off the critical path. Measured, it does not: the
      // check phase runs before the poll phase that actually writes the RPC
      // request to the socket, so the submission left at the same moment
      // either way — while the record spent that window existing only in
      // memory, where a crash loses the hash that reconciliation needs.
      // Same latency, strictly less durability, so: save first.
      this.store.recordBlock(record);
      this.store.save(true);
    }
    // Announced the moment it is found, not when the node has confirmed it.
    // Submission and its retry schedule can take a minute or more, and if it
    // ultimately fails this is the only notification that will ever be sent.
    // The later 'block' event replaces the notification rather than adding one.
    // emitSafely: a listener that throws here would otherwise abort the
    // submission entirely.
    this.emitSafely('blockfound', record);

    record.blockHex = hex;

    try {
      const response = await submit();
      // submitblock does not answer with a simple yes/no. Bitcoin Core, and
      // Dogecoin Core with it, returns null on success but also "duplicate",
      // "inconclusive" and "duplicate-inconclusive" for blocks that are
      // perfectly valid yet did not become the chain tip — typically because
      // somebody else's block for that height arrived first. Calling those
      // "rejected" would be both wrong and alarming.
      const verdict = response === null || response === undefined ? 'accepted' : String(response);

      if (verdict === 'accepted' || verdict === 'duplicate') {
        record.status = 'accepted';
        record.accepted = true;
        this.stats.blocksFound++;
        this.stats.lastBlock = record;
        if (this.store) {
          this.store.updateBlock(record.hash, { status: 'accepted', accepted: true });
          this.store.save(true);
        }
        this.log(`BLOCK ACCEPTED at ${where} — ${hash}`);
        // Also guarded: this call sits inside the try that decides the
        // block's fate, so a throwing listener would land in the catch below
        // and rewrite an ACCEPTED block to "error" — on disk.
        this.emitSafely('block', record);
      } else if (verdict.includes('inconclusive')) {
        record.status = 'stale';
        record.accepted = false;
        record.error = 'valid, but another block reached this height first';
        if (this.store) this.store.updateBlock(record.hash, { status: 'stale', accepted: false, error: record.error });
        this.log(`block at ${where} was orphaned (${verdict})`);
      } else {
        record.status = 'rejected';
        record.accepted = false;
        record.error = verdict;
        if (this.store) this.store.updateBlock(record.hash, { status: 'rejected', accepted: false, error: verdict });
        this.log(`${what} REJECTED by node: ${verdict}`);
      }
    } catch (err) {
      record.status = 'error';
      record.accepted = false;
      record.error = err.message;
      if (this.store) this.store.updateBlock(record.hash, { status: 'error', accepted: false, error: err.message });
      this.log(`${what} submission failed: ${err.message}`);
    }
    // Whatever happened, get a fresh template immediately.
    this.refreshTemplate('post-submit').catch(() => {});
  }

  // ------------------------------------------------------------------ vardiff

  // Aim for one share every `targetShareSeconds`. Miners here differ by more
  // than a factor of five in hashrate, so a single fixed difficulty would either
  // flood the server or leave the small miner apparently idle for minutes.
  retarget(client) {
    const window = this.config.vardiffWindow;
    // Anchor on a TIMESTAMP, not an index into shareTimes. That array is capped
    // and shifts its oldest entries out, so an index anchor stops matching the
    // data it points at: once the cap is reached the length stops growing, the
    // count of "shares since the last adjustment" sticks at zero, and vardiff
    // silently never adjusts again.
    const since = client.lastRetargetAt || 0;
    const sinceRetarget = client.shareTimes.filter((s) => s.at > since);
    if (sinceRetarget.length < window) return;
    const recent = sinceRetarget.slice(-window);
    const elapsed = (recent[recent.length - 1].at - recent[0].at) / 1000;
    if (elapsed <= 0) return;

    const actual = elapsed / (recent.length - 1);
    const desired = this.config.targetShareSeconds;
    const ratio = desired / actual;
    if (ratio > 0.75 && ratio < 1.33) return;

    // Round to a power of two BEFORE clamping. The other order lets the
    // rounding step push the result back outside the configured bounds.
    const next = clamp(
      roundDifficulty(client.difficulty * clamp(ratio, 0.25, 4)),
      this.config.minDifficulty,
      this.config.maxDifficulty
    );
    if (Math.abs(next - client.difficulty) / client.difficulty < 0.1) return;

    // Keep the share history: each entry carries the difficulty it was solved
    // at, so a mixed-difficulty window still sums correctly — and clearing it
    // would reset the hashrate estimate to a two-sample guess after every
    // adjustment.
    client.lastRetargetAt = Date.now();
    this.setDifficulty(client, next);
    if (this.currentJob) this.sendJob(client, this.currentJob, false);
  }

  // --------------------------------------------------------------- reporting

  clientHashrate(client) {
    // One share at stratum difficulty D costs D * 2^16 hashes on scrypt.
    // Using 2^32 here — the Bitcoin figure — would overstate every reading by
    // a factor of 65536.
    const cutoff = Date.now() - this.config.hashrateWindowMs;
    const recent = client.shareTimes.filter((s) => s.at >= cutoff);
    if (recent.length < 2) return 0;
    const seconds = (Date.now() - recent[0].at) / 1000;
    if (seconds <= 0) return 0;
    // Drop the first share from the numerator. The elapsed time spans the
    // intervals BETWEEN the samples, so counting all of them — including the
    // one that merely marks the start — inflates the estimate by n/(n-1),
    // which is a factor of two when the window is short.
    const work = recent.reduce((sum, s) => sum + s.difficulty, 0) - recent[0].difficulty;
    return (work * u.HASHES_PER_SHARE_UNIT) / seconds;
  }

  snapshot() {
    const workers = [...this.clients.values()]
      .filter((c) => c.authorized)
      .map((c) => ({
        id: c.id,
        worker: c.worker,
        userAgent: c.userAgent,
        remote: c.remote,
        difficulty: c.difficulty,
        hashrate: this.clientHashrate(c),
        accepted: c.accepted,
        rejected: c.rejected,
        bestShareDiff: c.bestShareDiff,
        payoutAddress: c.payoutAddress || this.config.payoutAddress,
        connectedAt: c.connectedAt,
        lastShareAt: c.lastShareAt,
        latencyMs: c.latencyMs == null ? null : c.latencyMs,
        latencyFrom: c.latencyFrom || null,
        rejectReasons: { ...(c.rejectReasons || {}) },
        // Recent share timestamps, so the dashboard can show the rhythm of a
        // worker rather than just a number. A miner that stalled two minutes
        // ago looks identical to a healthy one on an averaged hashrate.
        shareHistory: c.shareTimes.slice(-48).map((s) => s.at),
      }));

    const job = this.currentJob;
    // In merged mode the headline numbers stay DOGECOIN's — height, difficulty,
    // reward. This is a Dogecoin app: "how long until a block" means a Dogecoin
    // block, and showing Litecoin's height beside a Dogecoin payout address
    // would be actively misleading. The parent chain gets its own object.
    const merged = this.merged && job
      ? {
          parentChain: 'LTC',
          parentHeight: job.height,
          parentDifficulty: job.networkDifficulty,
          parentReward: job.coinbaseValue,
          parentPayoutAddress: this.config.ltcPayoutAddress,
        }
      : null;
    return {
      chain: this.chain,
      mergedMining: !!this.merged,
      merged,
      stratumPort: this.config.stratumPort,
      payoutAddress: this.config.payoutAddress,
      lockPayoutAddress: !!this.config.lockPayoutAddress,
      profile: this.config.profile || 'home',
      startedAt: this.stats.startedAt,
      height: job ? (this.merged ? job.auxHeight : job.height) : null,
      networkDifficulty: job ? (this.merged ? job.auxDifficulty : job.networkDifficulty) : null,
      smoothedDifficulty: this.smoothedDifficulty(),
      difficultySamples: (this.difficultyHistory || []).length,
      nodeLatencyMs: this.medianNodeLatency(),
      firstStartedAt: this.stats.firstStartedAt || this.stats.startedAt,
      coinbaseValue: job ? (this.merged ? job.auxValue : job.coinbaseValue) : null,
      templateAgeMs: this.stats.lastTemplateAt ? Date.now() - this.stats.lastTemplateAt : null,
      templateError: this.stats.templateError,
      auxError: this.stats.auxError || null,
      accepted: this.stats.accepted,
      rejected: this.stats.rejected,
      rejectReasons: this.stats.rejectReasons,
      // Consensus-space, so it is directly comparable with networkDifficulty.
      bestShareDiff: this.stats.bestShareDiff,
      // The same share expressed in the stratum units a miner reports, which
      // is 65536x larger. Rendering the consensus value in a widget shows "0"
      // for a perfectly healthy miner.
      bestShareStratum: this.stats.bestShareDiff * u.HASHES_PER_SHARE_UNIT,
      bestShareAt: this.stats.bestShareAt,
      blocksFound: this.stats.blocksFound,
      // Strip blockHex. A mainnet block is tens to hundreds of kilobytes, and
      // fifty of them re-serialised into every five-second dashboard poll turns
      // a win into a performance problem. The hex is kept in memory for a
      // manual resubmit and written to the container log when the block is
      // found; the dashboard has no use for it.
      blocks: this.stats.blocks.map(({ blockHex, ...rest }) => rest),
      workers,
      totalHashrate: workers.reduce((s, w) => s + w.hashrate, 0),
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Snap to powers of two. Scrypt ASIC firmware is derived from cgminer, which
// stores the stratum difficulty as a double and derives the target from it;
// clean powers of two avoid rounding disagreements between our target and the
// miner's, which would show up as shares we consider one notch too easy.
function roundDifficulty(d) {
  const exp = Math.round(Math.log2(d));
  return Math.pow(2, exp);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Pool };
