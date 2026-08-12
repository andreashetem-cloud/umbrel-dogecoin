'use strict';
//
// Merge-mine a real Dogecoin block under a real Litecoin parent, and have
// dogecoind accept it.
//
// This is the only test of merged mining that means anything. Every rule in
// auxpow.js is a rule enforced by a C++ function on the other side of an RPC
// socket, and the failure mode for getting one wrong is not an exception — it
// is a block that quietly does not count. So: build a genuine Litecoin block
// template, commit a genuine Dogecoin aux block to its coinbase, hash the
// Litecoin header with scrypt until it satisfies Dogecoin's target, and submit.
//
// It also checks the other direction, which is the point of merged mining:
// the same parent block is submitted to LITECOIN and accepted there too. One
// set of hashes, two chains.
//
// Usage: node test/merged_regtest.js <ltcRpcPort> <dogeRpcPort>
//

const crypto = require('node:crypto');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });

// --- minimal transaction building, mirroring what the pool does ------------

function varint(n) { return u.varIntBuffer(n); }

function buildParentCoinbase({ height, value, script, commitment, witnessCommitment, extraNonce }) {
  // scriptSig: BIP34 height, then our extra nonce, then the aux commitment.
  // The commitment must be the LAST thing that matters, but the rules only care
  // that the magic is unique and the root follows it, so ordering after the
  // height push is free.
  const scriptSig = Buffer.concat([
    u.coinbaseHeightScript(height),
    u.scriptPush(extraNonce),
    commitment,
  ]);
  if (scriptSig.length > 100) throw new Error(`scriptSig ${scriptSig.length} > 100`);

  const outputs = [];
  const payout = Buffer.alloc(8);
  payout.writeBigUInt64LE(BigInt(value), 0);
  outputs.push(Buffer.concat([payout, varint(script.length), script]));
  if (witnessCommitment) {
    const zero = Buffer.alloc(8);
    const wc = Buffer.from(witnessCommitment, 'hex');
    outputs.push(Buffer.concat([zero, varint(wc.length), wc]));
  }

  const tx = Buffer.concat([
    Buffer.from([1, 0, 0, 0]),                  // version
    varint(1),                                  // one input
    Buffer.alloc(32),                           // null prevout hash
    Buffer.from([0xff, 0xff, 0xff, 0xff]),      // prevout index
    varint(scriptSig.length), scriptSig,
    Buffer.from([0xff, 0xff, 0xff, 0xff]),      // sequence
    varint(outputs.length), Buffer.concat(outputs),
    Buffer.alloc(4),                            // locktime
  ]);
  return { tx, scriptSig };
}

// The same transaction WITH a witness, which is what Litecoin needs in the
// block when a witness commitment is present. The txid is unchanged.
function withWitness(tx) {
  const version = tx.subarray(0, 4);
  const rest = tx.subarray(4);
  return Buffer.concat([
    version,
    Buffer.from([0x00, 0x01]),                 // segwit marker and flag
    rest.subarray(0, rest.length - 4),          // inputs and outputs
    varint(1), varint(32), Buffer.alloc(32),    // one witness item: 32 zero bytes
    rest.subarray(rest.length - 4),             // locktime
  ]);
}

function buildHeader({ version, prevHash, merkleRoot, time, bits, nonce }) {
  const header = Buffer.alloc(80);
  header.writeInt32LE(version, 0);
  u.reverseBuffer(Buffer.from(prevHash, 'hex')).copy(header, 4);
  merkleRoot.copy(header, 36);
  header.writeUInt32LE(time, 68);
  u.reverseBuffer(Buffer.from(bits, 'hex')).copy(header, 72);
  header.writeUInt32LE(nonce, 76);
  return header;
}

(async () => {
  console.log('\nboth chains are reachable');
  const ltcInfo = await ltc.call('getblockchaininfo');
  const dogeInfo = await doge.call('getblockchaininfo');
  check('litecoind answers on regtest', ltcInfo.chain === 'regtest', ltcInfo.chain);
  check('dogecoind answers on regtest', dogeInfo.chain === 'regtest', dogeInfo.chain);
  check('the Dogecoin chain is past the height where auxpow is allowed',
    dogeInfo.blocks >= 20, String(dogeInfo.blocks));

  // A Litecoin address to pay the parent block to, and a Dogecoin one for the
  // aux block. They are different chains, so different addresses.
  // A legacy address: the coinbase script builder handles P2PKH and P2SH, and
  // a bech32 one would need a different output type. Litecoin still pays these.
  const ltcAddress = await ltc.call('getnewaddress', ['', 'legacy']);
  const dogeAddress = await doge.call('getnewaddress');

  console.log('\nDogecoin hands out an aux block to work on');
  const auxBlock = await doge.call('createauxblock', [dogeAddress]);
  check('it has a hash', /^[0-9a-f]{64}$/.test(auxBlock.hash), auxBlock.hash);
  check('it declares chain 98', auxBlock.chainid === 98, String(auxBlock.chainid));
  check('it gives us a target', /^[0-9a-f]{64}$/.test(auxBlock._target || auxBlock.target),
    auxBlock._target || auxBlock.target);

  // Both targets are derived from `bits`, NOT from the target strings — because
  // the two nodes disagree about byte order and nothing warns you:
  //
  //   litecoind   getblocktemplate.target  7fffff00…00   big-endian
  //   dogecoind   createauxblock._target   00…00ffff7f   little-endian
  //
  // Read the wrong way round, Litecoin's target becomes 0xffff7f — a target so
  // small nothing ever meets it, so the pool would silently never submit a
  // Litecoin block. Read the other wrong way round it becomes astronomically
  // easy and every share looks like a block. `bits` is unambiguous on both
  // chains, so it is the source of truth here and the strings are used only to
  // cross-check that assumption.
  const targetHex = auxBlock._target || auxBlock.target;
  const auxTarget = u.targetFromBits(auxBlock.bits);
  check('the aux target parses to a sane number', auxTarget > 0n, auxBlock.bits);
  check('Dogecoin reports _target little-endian, as expected',
    u.bufferToBigInt(u.reverseBuffer(Buffer.from(targetHex, 'hex'))) === auxTarget, targetHex);

  console.log('\na real Litecoin block is built around that commitment');
  const template = await ltc.call('getblocktemplate', [{ rules: ['mweb', 'segwit'] }]);
  const commitment = aux.auxCommitment(auxBlock.hash, 0);
  check('the commitment starts with the merged-mining magic',
    commitment.subarray(0, 4).equals(aux.MERGED_MINING_HEADER), commitment.subarray(0, 4).toString('hex'));
  check('it is 44 bytes: magic, hash, size, nonce', commitment.length === 44, String(commitment.length));

  const script = u.addressToScript(ltcAddress, 'ltc-regtest');
  const { tx: coinbase, scriptSig } = buildParentCoinbase({
    height: template.height,
    value: template.coinbasevalue,
    script,
    commitment,
    witnessCommitment: template.default_witness_commitment,
    extraNonce: crypto.randomBytes(4),
  });

  const coinbaseHash = u.sha256d(coinbase);
  const coinbaseTxid = u.reverseBuffer(coinbaseHash).toString('hex');

  // Regtest templates are empty, but the branch is computed the same way a
  // production one would be — this is the code that has to be right when the
  // mempool is not empty.
  const otherTxids = (template.transactions || []).map((t) => u.reverseBuffer(Buffer.from(t.txid || t.hash, 'hex')));
  const merkleSteps = u.merkleSteps(otherTxids);
  const merkleRoot = u.merkleRootFromSteps(coinbaseHash, merkleSteps);

  const selfCheck = aux.verifyAuxPow({
    scriptSig,
    auxHashHex: auxBlock.hash,
    chainId: 98,
    coinbaseTxid,
    merkleBranch: merkleSteps,
    parentMerkleRoot: u.reverseBuffer(merkleRoot).toString('hex'),
    parentVersion: template.version,
  });
  check('our own rule check passes before anything is submitted', selfCheck.ok,
    selfCheck.problems.join(' | '));

  console.log('\nhashing the Litecoin header until it satisfies BOTH chains');
  // Deliberately mined against the harder of the two targets, so this test
  // proves the whole point of merged mining rather than only half of it: one
  // header, accepted by two independent chains.
  const ltcTargetForMining = u.targetFromBits(template.bits);
  check('Litecoin reports target big-endian, as expected',
    u.bufferToBigInt(Buffer.from(template.target, 'hex')) === ltcTargetForMining, template.target);
  const goal = auxTarget < ltcTargetForMining ? auxTarget : ltcTargetForMining;
  let header = null;
  let nonce = 0;
  let powValue = null;
  const started = Date.now();
  for (; nonce < 5000000; nonce++) {
    header = buildHeader({
      version: template.version,
      prevHash: template.previousblockhash,
      merkleRoot,
      time: template.curtime,
      bits: template.bits,
      nonce,
    });
    const pow = u.scryptHash(header);
    powValue = u.bufferToBigInt(u.reverseBuffer(pow));
    if (powValue <= goal) break;
    if (Date.now() - started > 120000) break;
  }
  check('a header was found that meets the Dogecoin target', powValue !== null && powValue <= auxTarget,
    `after ${nonce} nonces`);

  console.log('\nDogecoin accepts the merge-mined block');
  const auxpowHex = aux.serializeAuxPow({
    coinbaseTx: coinbase,
    parentBlockHash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
    merkleBranch: merkleSteps,
    parentHeader: header,
  }).toString('hex');

  const before = await doge.call('getblockcount');
  const submitted = await doge.call('submitauxblock', [auxBlock.hash, auxpowHex]);
  check('submitauxblock returns true', submitted === true, JSON.stringify(submitted));

  const after = await doge.call('getblockcount');
  check('the Dogecoin chain grew by one', after === before + 1, `${before} -> ${after}`);

  const tip = await doge.call('getblock', [await doge.call('getblockhash', [after])]);
  check('the new tip is the block we submitted', tip.hash === auxBlock.hash, `${tip.hash} vs ${auxBlock.hash}`);
  check('and it is recorded as an auxpow block', !!tip.auxpow, JSON.stringify(Object.keys(tip)).slice(0, 120));

  // The reward has to have gone where we asked.
  const coinbaseTxOnChain = await doge.call('getrawtransaction', [tip.tx[0], 1]);
  const paidTo = coinbaseTxOnChain.vout.flatMap((o) => (o.scriptPubKey.addresses || []));
  check('the block reward pays the address we asked for', paidTo.includes(dogeAddress),
    JSON.stringify(paidTo));

  console.log('\nthe same parent block is also a Litecoin block');
  // On regtest the Litecoin target is easy, so the header that satisfied
  // Dogecoin satisfies Litecoin as well — which is exactly the case that makes
  // merged mining worth doing.
  const ltcTarget = ltcTargetForMining;
  check('the same header satisfies the Litecoin target as well', powValue <= ltcTarget,
    'the harder target was Dogecoin\'s, so this half is untested');
  if (powValue <= ltcTarget) {
    const body = Buffer.concat([
      header,
      varint(1 + (template.transactions || []).length),
      template.default_witness_commitment ? withWitness(coinbase) : coinbase,
      ...(template.transactions || []).map((t) => Buffer.from(t.data, 'hex')),
      // MWEB, if the chain has it: one presence flag, then the blob, AFTER the
      // transaction list. This test file carries its own serialiser on purpose —
      // it is meant to be an independent check of the product's — but that also
      // means it can carry the same bug, and it did.
      ...(template.mweb ? [Buffer.from([0x01]), Buffer.from(template.mweb, 'hex')] : []),
    ]);
    const ltcBefore = await ltc.call('getblockcount');
    const result = await ltc.call('submitblock', [body.toString('hex')]);
    check('litecoind accepts the very same header', result === null || result === undefined,
      JSON.stringify(result));
    const ltcAfter = await ltc.call('getblockcount');
    check('the Litecoin chain grew by one too', ltcAfter === ltcBefore + 1, `${ltcBefore} -> ${ltcAfter}`);
  } else {
    console.log('  --    the header did not meet the Litecoin target; skipping that half');
  }

  console.log(failures === 0 ? '\nMERGED MINING VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
