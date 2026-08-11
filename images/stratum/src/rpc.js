'use strict';
//
// Minimal JSON-RPC client for dogecoind. No dependencies, no retry magic —
// callers decide what a failure means, because "template fetch failed" and
// "block submission failed" need very different responses.
//

const http = require('node:http');

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

class RpcClient {
  constructor({ host, port, user, password, timeout = 15000 }) {
    this.host = host;
    this.port = port;
    this.auth =
      user || password
        ? Buffer.from(`${user || ''}:${password || ''}`).toString('base64')
        : null;
    this.timeout = timeout;
    this.nextId = 1;
  }

  call(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: this.nextId++,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.auth) headers.Authorization = `Basic ${this.auth}`;

      const req = http.request(
        { host: this.host, port: this.port, method: 'POST', path: '/', headers },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            // A block template with a full mempool is large but bounded; this
            // cap stops a wedged or hostile endpoint from exhausting memory.
            if (size > 64 * 1024 * 1024) {
              req.destroy(new Error('RPC response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401) {
              reject(new RpcError('RPC authentication failed', 401));
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(
                new RpcError(
                  `RPC returned non-JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`,
                  res.statusCode
                )
              );
              return;
            }
            if (parsed.error) {
              reject(
                new RpcError(parsed.error.message || 'RPC error', parsed.error.code)
              );
              return;
            }
            resolve(parsed.result);
          });
        }
      );

      req.setTimeout(this.timeout, () => {
        req.destroy(new RpcError(`RPC ${method} timed out`, 'ETIMEDOUT'));
      });
      req.on('error', (err) => reject(err));
      req.end(body);
    });
  }

  getBlockTemplate() {
    // Dogecoin 1.14 accepts an empty request; passing capabilities keeps us
    // explicit about the fact that we build our own coinbase.
    return this.call('getblocktemplate', [
      { capabilities: ['coinbasetxn', 'workid', 'coinbase/append'], rules: [] },
    ]);
  }

  submitBlock(hex) {
    return this.call('submitblock', [hex]);
  }
}

module.exports = { RpcClient, RpcError };
