'use strict';
//
// The MWEB tail of a Litecoin block.
//
// Why this test exists as bytes rather than as a live block: MWEB has been
// active on Litecoin MAINNET since block 2,265,984, and getblocktemplate
// returns an `mweb` field on every template after it — even with no MWEB
// activity at all. A regtest chain has it inactive, so the code path that
// handles it is dead during every other test in this suite. That is precisely
// how the original bug survived: the block was serialised with the MWEB blob
// appended raw, litecoind answered `mweb-missing`, and on regtest nothing ever
// noticed. Every Litecoin block the pool ever found would have been rejected
// while the Dogecoin half kept working perfectly.
//
// The structure asserted here was established by building both forms against a
// real MWEB-active litecoind: the raw-blob form was rejected with
// `mweb-missing`, the flagged form was accepted and extended the chain, and a
// block litecoind produced itself byte-matched header || varint(n) || txs ||
// 0x01 || mweb.
//

const { MergedJob } = require('../images/stratum/src/merged');
const u = require('../images/stratum/src/util');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A template shaped like a post-activation Litecoin one. Only the fields the
// serialiser touches need to be real.
function templateWith(mweb, transactions = []) {
  return {
    version: 0x20000000,
    previousblockhash: 'ab'.repeat(32),
    curtime: 1786000000,
    mintime: 1785999000,
    bits: '207fffff',
    height: 2400000,
    coinbasevalue: 625000000,
    target: '7fffff' + '00'.repeat(29),
    transactions,
    ...(mweb ? { mweb } : {}),
  };
}

const auxBlock = {
  hash: 'cd'.repeat(32),
  chainid: 98,
  bits: '1a01b7d1',
  height: 6400000,
  coinbasevalue: 1000000000000,
  previousblockhash: 'ef'.repeat(32),
};

// A P2PKH script; the payout path is not what is under test here.
const script = Buffer.concat([
  Buffer.from([0x76, 0xa9, 0x14]), Buffer.alloc(20, 7), Buffer.from([0x88, 0xac]),
]);

const MWEB_HEX = 'de'.repeat(167); // the size an idle mainnet template carries

// Two ordinary transactions, so the MWEB tail has something to come AFTER.
// With an empty transaction list "flag after the transactions" and "flag before
// them" serialise identically, and the placement is the one structural fact
// that made the original bug possible: a mutant that puts the blob before the
// transactions passes an empty-list test and is rejected by litecoin with
// "Block decode failed" on any real template.
const TX_A = 'aa'.repeat(60);
const TX_B = 'bb'.repeat(40);
// txid as well as data: the job builds the merkle tree from the txids, and a
// template entry without one is not a template entry.
const TXS = [
  { data: TX_A, txid: '11'.repeat(32) },
  { data: TX_B, txid: '22'.repeat(32) },
];

console.log('\nan MWEB-carrying template');
{
  const job = new MergedJob('1', templateWith(MWEB_HEX, TXS), script, '/test/', auxBlock);
  const coinbase = job.buildCoinbase(Buffer.alloc(4), Buffer.alloc(4));
  const header = job.buildHeader(u.sha256d(coinbase), 1786000001, 1);
  const hex = job.serializeBlock(header, coinbase);
  const block = Buffer.from(hex, 'hex');

  const tail = block.subarray(block.length - (1 + 167));
  check('the block ends with the MWEB blob', tail.subarray(1).toString('hex') === MWEB_HEX,
    tail.subarray(1).toString('hex').slice(0, 20));
  check('and the blob is preceded by the 0x01 presence flag', tail[0] === 0x01,
    '0x' + tail[0].toString(16));
  check('the flag is not part of the blob itself',
    block.subarray(block.length - 167).toString('hex') === MWEB_HEX);

  // Placement: the tail must be transactions, THEN flag, THEN blob.
  const hexAll = block.toString('hex');
  check('the transactions come before the MWEB tail',
    hexAll.indexOf(TX_B) >= 0 && hexAll.indexOf(TX_B) < hexAll.indexOf('01' + MWEB_HEX),
    `tx at ${hexAll.indexOf(TX_B)}, mweb at ${hexAll.indexOf('01' + MWEB_HEX)}`);
  check('both transactions are present exactly once',
    hexAll.split(TX_A).length === 2 && hexAll.split(TX_B).length === 2);
  check('nothing follows the MWEB blob',
    hexAll.endsWith(MWEB_HEX), hexAll.slice(-8));
}

console.log('\na template without MWEB is unchanged');
{
  const job = new MergedJob('2', templateWith(null), script, '/test/', auxBlock);
  const coinbase = job.buildCoinbase(Buffer.alloc(4), Buffer.alloc(4));
  const header = job.buildHeader(u.sha256d(coinbase), 1786000001, 1);
  const block = Buffer.from(job.serializeBlock(header, coinbase), 'hex');

  // An exact length, with no escape hatch. The earlier version of this check
  // carried an `|| block.length > 81` alternative that made it impossible to
  // fail — a mutant appending a stray byte passed it.
  check('the block is exactly header + count + coinbase',
    block.length === 80 + 1 + coinbase.length,
    `${block.length} vs ${80 + 1 + coinbase.length}`);
}

console.log('\nan empty mweb field is treated as absent');
{
  const job = new MergedJob('3', templateWith(''), script, '/test/', auxBlock);
  const coinbase = job.buildCoinbase(Buffer.alloc(4), Buffer.alloc(4));
  const header = job.buildHeader(u.sha256d(coinbase), 1786000001, 1);
  const block = Buffer.from(job.serializeBlock(header, coinbase), 'hex');
  // An empty string must not produce a lone 0x01 flag with nothing behind it,
  // which litecoind would read as a truncated MWEB block.
  check('an empty mweb string appends nothing at all',
    block.length === 80 + 1 + coinbase.length, String(block.length - (80 + 1 + coinbase.length)));
}

console.log(failures === 0 ? '\nMWEB SERIALISATION VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
