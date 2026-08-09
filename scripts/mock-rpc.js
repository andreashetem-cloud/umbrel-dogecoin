// Dev-only: a fake dogecoind JSON-RPC endpoint so the dashboard can be
// developed and screenshotted without syncing a real node.
const http = require('node:http');

const now = Math.floor(Date.now() / 1000);
const RESPONSES = {
  getblockchaininfo: {
    chain: 'main',
    blocks: 5741220,
    headers: 5741220,
    bestblockhash: '00000000000000001a2b3c4d5e6f70819293a4b5c6d7e8f900112233445566778',
    difficulty: 27482913.44,
    mediantime: now - 47,
    verificationprogress: 0.9999987,
    initialblockdownload: false,
    pruned: false,
    size_on_disk: 152_600_000_000,
  },
  getnetworkinfo: {
    version: 1140900,
    subversion: '/Shibetoshi:1.14.9/',
    protocolversion: 70015,
    connections: 27,
    networks: [
      { name: 'ipv4', reachable: true },
      { name: 'onion', reachable: true },
    ],
    warnings: '',
  },
  getmempoolinfo: { size: 143, bytes: 61_233 },
  getmininginfo: { networkhashps: 1.42e15 },
  getnettotals: { totalbytesrecv: 162_884_129_331, totalbytessent: 24_113_887_002 },
  getpeerinfo: Array.from({ length: 27 }, (_, i) => ({
    addr: `${['82.14.9', '176.9.42', '45.63.11', '188.40.7'][i % 4]}.${20 + i}:22556`,
    subver: `/Shibetoshi:1.14.${[9, 8, 7, 6][i % 4]}/`,
    inbound: i % 3 === 0,
    pingtime: 0.02 + (i % 7) * 0.011,
    synced_blocks: 5741220 - (i % 3),
  })),
};

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let method = '';
      try {
        method = JSON.parse(body).method;
      } catch {}
      const result = RESPONSES[method];
      res.writeHead(result === undefined ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          result === undefined
            ? { result: null, error: { code: -32601, message: `Method not found: ${method}` } }
            : { result, error: null, id: 'mock' }
        )
      );
    });
  })
  .listen(22555, '127.0.0.1', () => console.log('mock dogecoind RPC on 127.0.0.1:22555'));
