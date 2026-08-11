'use strict';
//
// The test that matters: build a block with our own code and make a real
// dogecoind accept it. If the coinbase, merkle root, header layout or scrypt
// parameters were wrong in any byte, submitblock says so.
//
// Usage: node test/mine_regtest.js <datadir-rpc-port> <payout-address> [chain]
//

const { RpcClient } = require('../images/stratum/src/rpc');
const { Job, validateShare } = require('../images/stratum/src/job');
const u = require('../images/stratum/src/util');

const port = Number(process.argv[2] || 18332);
const address = process.argv[3];
const chain = process.argv[4] || 'regtest';

if (!address) {
  console.error('usage: node test/mine_regtest.js <rpc-port> <address> [chain]');
  process.exit(2);
}

const rpc = new RpcClient({ host: '127.0.0.1', port, user: 'test', password: 'test' });

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function mineOne(round) {
  const template = await rpc.getBlockTemplate();
  const script = u.addressToScript(address, chain);
  const job = new Job(`job${round}`, template, script);

  const extranonce1 = Buffer.from('deadbeef', 'hex');
  const shareTarget = job.networkTarget; // regtest: everything is a block

  let found = null;
  // Roll extranonce2 as well as the nonce, exactly as a miner would, so the
  // coinbase-splice path is exercised rather than assumed.
  outer: for (let e2 = 0; e2 < 64; e2++) {
    const extranonce2Hex = e2.toString(16).padStart(8, '0');
    for (let nonce = 0; nonce < 200000; nonce++) {
      const res = validateShare(job, {
        extranonce1,
        extranonce2Hex,
        ntimeHex: job.curtime.toString(16).padStart(8, '0'),
        nonceHex: nonce.toString(16).padStart(8, '0'),
        shareTarget,
      });
      if (res.ok && res.isBlockCandidate) {
        found = res;
        break outer;
      }
    }
  }

  if (!found) throw new Error('no valid nonce found — regtest target unexpectedly hard');

  const before = await rpc.call('getblockcount');
  const result = await rpc.submitBlock(found.blockHex);

  check(`round ${round}: submitblock accepted`, result === null, `returned ${JSON.stringify(result)}`);

  const after = await rpc.call('getblockcount');
  check(`round ${round}: chain advanced`, after === before + 1, `${before} -> ${after}`);

  const tip = await rpc.call('getblockhash', [after]);
  check(`round ${round}: our block is the tip`, tip === found.blockHash, `${tip} vs ${found.blockHash}`);

  const block = await rpc.call('getblock', [tip, 2]);
  check(`round ${round}: height matches template`, block.height === template.height);
  check(
    `round ${round}: transactions carried over`,
    block.tx.length === template.transactions.length + 1,
    `${block.tx.length} vs ${template.transactions.length + 1}`
  );

  const coinbase = block.tx[0];
  const out = coinbase.vout[0];
  check(
    `round ${round}: reward pays our address`,
    out.scriptPubKey.addresses && out.scriptPubKey.addresses.includes(address),
    JSON.stringify(out.scriptPubKey.addresses)
  );
  check(
    `round ${round}: reward value matches coinbasevalue`,
    Math.round(out.value * 1e8) === template.coinbasevalue,
    `${Math.round(out.value * 1e8)} vs ${template.coinbasevalue}`
  );
  check(
    `round ${round}: block version preserved`,
    block.version === template.version,
    `${block.version} vs ${template.version}`
  );

  return found;
}

(async () => {
  console.log('mining regtest blocks through our own block construction\n');

  // Round 1 exercises the empty-mempool case, round 2+ the merkle branch with
  // real transactions in it.
  await mineOne(1);
  await mineOne(2);

  console.log('\nsanity checks on the primitives');
  const script = u.addressToScript(address, chain);
  const viaNode = await rpc.call('validateaddress', [address]);
  check(
    'addressToScript matches dogecoind',
    script.toString('hex') === viaNode.scriptPubKey,
    `${script.toString('hex')} vs ${viaNode.scriptPubKey}`
  );

  let threw = false;
  try {
    u.addressToScript(address.slice(0, -1) + (address.slice(-1) === 'a' ? 'b' : 'a'), chain);
  } catch {
    threw = true;
  }
  check('a corrupted address is rejected by the checksum', threw);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nfatal:', err.message);
  process.exit(1);
});
