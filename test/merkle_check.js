'use strict';
//
// Cross-check the merkle implementation against Dogecoin Core.
//
// Takes real blocks from a running node, rebuilds each merkle root from the
// txids using the same coinbase-placeholder branch we hand to miners, and
// compares against the merkleroot dogecoind recorded in the header.
//

const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');

const port = Number(process.argv[2] || 18332);
const count = Number(process.argv[3] || 12);

const rpc = new RpcClient({ host: '127.0.0.1', port, user: 'test', password: 'test' });

let failures = 0;
let compared = 0;
let withTxs = 0;

(async () => {
  const height = await rpc.call('getblockcount');
  for (let h = Math.max(1, height - count + 1); h <= height; h++) {
    const block = await rpc.call('getblock', [await rpc.call('getblockhash', [h])]);
    const txids = block.tx;
    if (txids.length > 1) withTxs++;

    // Internal byte order, coinbase first.
    const internal = txids.map((t) => u.reverseBuffer(Buffer.from(t, 'hex')));
    const coinbaseHash = internal[0];
    const steps = u.merkleSteps(internal.slice(1));
    const root = u.merkleRootFromSteps(coinbaseHash, steps);
    const asDisplayed = u.reverseBuffer(root).toString('hex');

    compared++;
    if (asDisplayed !== block.merkleroot) {
      failures++;
      console.log(`  FAIL  height ${h} (${txids.length} tx): ${asDisplayed} vs ${block.merkleroot}`);
    }
  }

  console.log(`  ok    ${compared} blocks reproduced, ${withTxs} of them with real transactions`);
  if (withTxs < 1) {
    failures++;
    console.log('  FAIL  no multi-transaction block was checked; the branch path is untested');
  }
  console.log(failures === 0 ? '\nMERKLE MATCHES DOGECOIN CORE' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
