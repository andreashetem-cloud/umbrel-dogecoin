'use strict';
//
// Simulated miners for screenshots and for exercising the dashboard against a
// running stratum server. Submits genuinely valid shares — it does the scrypt
// work — at a controlled rate, so the sparklines and hashrate readings show
// real data rather than fabricated numbers.
//

const net = require('node:net');
const u = require('../images/stratum/src/util');

const PORT = Number(process.argv[2] || 22557);

function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}

class SimMiner {
  constructor({ name, username, userAgent, intervalMs }) {
    this.name = name;
    this.username = username;
    this.userAgent = userAgent;
    this.intervalMs = intervalMs;
    this.buf = '';
    this.id = 1;
    this.job = null;
    this.difficulty = 1;
    this.nonce = Math.floor(Math.random() * 1e6);
  }

  start() {
    this.socket = net.connect(PORT, '127.0.0.1', () => {
      this.send('mining.subscribe', [this.userAgent]);
      this.send('mining.authorize', [this.username, 'x']);
    });
    this.socket.on('data', (c) => this.onData(c));
    this.socket.on('error', (e) => console.error(`${this.name}: ${e.message}`));
    this.timer = setInterval(() => this.work(), this.intervalMs);
  }

  send(method, params) {
    const id = this.id++;
    if (!this.pending) this.pending = new Map();
    this.pending.set(id, method);
    this.socket.write(JSON.stringify({ id, method, params }) + '\n');
  }

  onData(chunk) {
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const requested = this.pending && m.id != null ? this.pending.get(m.id) : null;
      if (requested) this.pending.delete(m.id);
      if (requested === 'mining.subscribe' && Array.isArray(m.result)) {
        this.extranonce1 = Buffer.from(m.result[1], 'hex');
        continue;
      }
      if (m.method === 'mining.set_difficulty') {
        this.difficulty = m.params[0];
      } else if (m.method === 'mining.notify') {
        const [id, prev, cb1, cb2, branch, version, nbits, ntime] = m.params;
        this.job = { id, prev, cb1, cb2, branch, version, nbits, ntime };
      } else if (m.result === true) {
        this.accepted = (this.accepted || 0) + 1;
      } else if (m.error) {
        console.error(`${this.name}: rejected — ${JSON.stringify(m.error)}`);
      }
    }
  }

  work() {
    if (!this.job || !this.extranonce1) return;
    const target = u.targetFromShareDifficulty(this.difficulty);
    const prevInternal = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(this.job.prev, 'hex'))));
    const version = parseInt(this.job.version, 16);
    const nbits = parseInt(this.job.nbits, 16);
    const ntime = parseInt(this.job.ntime, 16);

    const en2 = Buffer.alloc(4);
    en2.writeUInt32BE((this.e2 = (this.e2 || 0) + 1) >>> 0, 0);
    const coinbase = Buffer.concat([
      Buffer.from(this.job.cb1, 'hex'), this.extranonce1, en2, Buffer.from(this.job.cb2, 'hex'),
    ]);
    let root = u.sha256d(coinbase);
    for (const s of this.job.branch) root = u.sha256d(Buffer.concat([root, Buffer.from(s, 'hex')]));

    for (let i = 0; i < 40000; i++) {
      const nonce = (this.nonce++) >>> 0;
      const header = Buffer.alloc(80);
      header.writeInt32LE(version, 0);
      prevInternal.copy(header, 4);
      root.copy(header, 36);
      header.writeUInt32LE(ntime, 68);
      header.writeUInt32LE(nbits, 72);
      header.writeUInt32LE(nonce, 76);
      if (u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header))) <= target) {
        this.send('mining.submit', [
          this.username, this.job.id, en2.toString('hex'),
          this.job.ntime, nonce.toString(16).padStart(8, '0'),
        ]);
        return;
      }
    }
  }
}

const miners = [
  new SimMiner({ name: 'lg07', username: process.argv[3] || 'lg07', userAgent: 'cgminer/4.10.0 (LuckyMiner LG07)', intervalMs: 2600 }),
  new SimMiner({ name: 'dogexus', username: process.argv[4] || 'dogexus', userAgent: 'cgminer/4.11.1 (Dogexus)', intervalMs: 1100 }),
];
for (const m of miners) m.start();

console.log(`simulating ${miners.length} miners against 127.0.0.1:${PORT}`);
