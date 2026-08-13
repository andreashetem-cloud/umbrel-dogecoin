'use strict';
//
// A dogecoind and a litecoind, in-process, with just enough behaviour to start
// a real Pool against.
//
// This exists because the most valuable checks in this repo are the ones that
// need a POOL rather than a function: that start() actually launches the aux
// longpoll, that a Dogecoin tip move really does reach the miners in
// milliseconds, that the healthcheck fails once a running pool stops getting
// work. Every one of those was untested — a reviewer proved it by deleting the
// line that launches the loop and watching the whole suite stay green.
//
// The interesting part is the longpoll, and it is modelled on the real thing
// (Dogecoin Core 1.14.9, src/rpc/mining.cpp): a call carrying a longpollid that
// matches the current tip BLOCKS until the tip moves; one carrying a spent id
// returns immediately. `stall()` makes it block forever, which is how the
// thread-leak defence is tested without waiting two minutes for a real timeout.
//

const http = require('node:http');

class MockNode {
  /**
   * @param {object} opts
   * @param {string} opts.chain      'main' for the pool's address validation
   * @param {boolean} opts.aux       serve createauxblock / submitauxblock
   */
  constructor({ chain = 'main', aux = false } = {}) {
    this.chain = chain;
    this.aux = aux;
    this.height = 1000;
    this.tip = 'aa'.repeat(32);
    // The transactions-updated counter Core embeds in the longpollid. It is
    // what makes a longpoll return WITHOUT the tip having moved.
    this.mempool = 1;
    this.calls = [];
    this.waiters = [];
    // Every request fails while this is set, as a node that has been switched
    // off does.
    this.down = false;
    // Longpolls never answer while this is set, as a node whose tip and mempool
    // are both still does.
    this.stalled = false;
    this.submitted = [];
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    for (const w of this.waiters.splice(0)) w.res.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  countOf(method) {
    return this.calls.filter((c) => c.method === method).length;
  }

  lastCall(method) {
    return [...this.calls].reverse().find((c) => c.method === method) || null;
  }

  // Move the tip, releasing anything longpolling on the old one.
  mine() {
    this.height++;
    this.tip = this.height.toString(16).padStart(64, '0');
    for (const w of this.waiters.splice(0)) this.answer(w.res, w.id, this.template());
    return this.tip;
  }

  // Release the longpoll WITHOUT moving the tip — Core's other exit from the
  // wait, taken about a minute after the mempool changes. Verified against the
  // real binary: one transaction sent, no block generated, and the longpoll
  // returned after 60002ms with the tip unchanged. A pool that counts this as a
  // tip movement reports roughly double the real figure.
  bumpMempool() {
    this.mempool++;
    for (const w of this.waiters.splice(0)) this.answer(w.res, w.id, this.template());
  }

  template() {
    return {
      version: 0x20000000,
      previousblockhash: this.tip,
      curtime: 1786000000,
      mintime: 1785999000,
      bits: '207fffff',
      height: this.height + 1,
      coinbasevalue: 625000000,
      target: '7f'.padEnd(64, 'f'),
      transactions: [],
      // A coinbase the pool cannot build: 44 of the scriptSig's 100 bytes are
      // the aux commitment, so this pushes it over the consensus limit and
      // MergedJob refuses. A plausible way for a template to be unusable
      // without the node being unreachable.
      ...(this.badTemplate ? { coinbaseaux: { flags: 'ff'.repeat(90) } } : {}),
      // What the pool's longpoll loop keys off: tip plus a counter, exactly as
      // Core builds it.
      longpollid: `${this.tip}${this.mempool}`,
      default_witness_commitment: null,
      mweb: '',
    };
  }

  auxBlock() {
    return {
      hash: (this.height + 1).toString(16).padStart(64, '7'),
      chainid: 98,
      bits: '1a01b7d1',
      height: this.height + 1,
      coinbasevalue: 1000000000000,
      previousblockhash: this.tip,
    };
  }

  answer(res, id, result) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify({ result, error: null, id });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  fail(res, id, message, code = -1) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify({ result: null, error: { code, message }, id });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  onRequest(req, res) {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return this.fail(res, null, 'bad json'); }
      const { method, params = [], id } = msg;
      this.calls.push({ method, params, at: Date.now() });

      if (this.down) return this.fail(res, id, 'connect ECONNREFUSED');

      switch (method) {
        case 'getblockchaininfo':
          return this.answer(res, id, { chain: this.chain, blocks: this.height });
        case 'getblocktemplate': {
          const lp = params[0] && params[0].longpollid;
          if (lp) {
            // A spent id returns at once — the behaviour that makes the
            // throttle in the pool's loop non-optional.
            if (lp !== `${this.tip}${this.mempool}`) return this.answer(res, id, this.template());
            // Otherwise block until the tip moves, like the real wait loop.
            if (this.stalled) return this.waiters.push({ res, id, stalled: true });
            return this.waiters.push({ res, id });
          }
          return this.answer(res, id, this.template());
        }
        case 'createauxblock':
          if (!this.aux) return this.fail(res, id, 'Method not found', -32601);
          return this.answer(res, id, this.auxBlock());
        case 'submitauxblock':
          this.submitted.push({ method, params });
          return this.answer(res, id, true);
        case 'submitblock':
          this.submitted.push({ method, params });
          return this.answer(res, id, null);
        case 'getblock':
          return this.fail(res, id, 'Block not found');
        default:
          return this.fail(res, id, `Method not found: ${method}`, -32601);
      }
    });
  }
}

module.exports = { MockNode };
