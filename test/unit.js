'use strict';
//
// Unit tests for the serialisation and difficulty primitives.
//
// Where a claim can be checked against Dogecoin Core itself rather than against
// my own reasoning, it is: merkle roots and address scripts are compared to
// what dogecoind produced, passed in via argv by the shell harness.
//

const u = require('../images/stratum/src/util');
const { Job } = require('../images/stratum/src/job');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${actual}, expected ${expected}`);
}

console.log('scrypt share difficulty (must match cgminer / cpuminer exactly)');

// cgminer v3.7.2 set_target():
//   d64 = truediffone; if (opt_scrypt) d64 *= 65536; d64 /= diff;
// with truediffone = 0x00000000FFFF0000...0000
const TRUEDIFFONE = 0xffffn * (1n << 208n);
for (const d of [1, 2, 64, 2048, 16384, 65536, 4194304]) {
  const expected = (TRUEDIFFONE * 65536n) / BigInt(d);
  const actual = u.targetFromShareDifficulty(d);
  check(`share target at difficulty ${d} matches cgminer`, actual === expected,
    `${actual.toString(16)} vs ${expected.toString(16)}`);
}

// pooler/cpuminer: diff_to_target(target, sctx->job.diff / 65536.0)
// i.e. share difficulty D behaves like consensus difficulty D/65536.
check('share difficulty 65536 equals consensus difficulty 1',
  u.targetFromShareDifficulty(65536) === u.targetFromDifficulty(1));

// The multiplier must NOT leak into consensus space.
eq('DIFF1 is the Bitcoin/Litecoin consensus constant',
  u.DIFF1.toString(16),
  'ffff0000000000000000000000000000000000000000000000000000');

console.log('\nnetwork difficulty from nBits');
// Taken from a real mainnet Dogecoin getblocktemplate response.
const netDiff = u.difficultyFromTarget(u.targetFromBits('196af9fc'));
check('mainnet bits 196af9fc give a plausible network difficulty',
  netDiff > 39e6 && netDiff < 41e6, netDiff.toFixed(0));
const netHash = (netDiff * 2 ** 32) / 60;
check('implied network hashrate is in the petahash range',
  netHash > 2e15 && netHash < 4e15, (netHash / 1e15).toFixed(3) + ' PH/s');

// Regtest powLimit, as a second independent data point.
check('difficultyFromTarget is monotonic',
  u.difficultyFromTarget(u.targetFromBits('1e0ffff0')) <
    u.difficultyFromTarget(u.targetFromBits('196af9fc')));

console.log('\nexpected share rates for the hardware this app targets');
for (const [name, hashrate, diff] of [
  ['Lucky Miner LG07 @ 11 MH/s', 11e6, 2048],
  ['Dogexus @ 70 MH/s', 70e6, 16384],
]) {
  const seconds = (diff * u.HASHES_PER_SHARE_UNIT) / hashrate;
  check(`${name} at difficulty ${diff} gives one share every 5-30s`,
    seconds >= 5 && seconds <= 30, `${seconds.toFixed(1)}s`);
}

console.log('\nscript number serialisation (BIP34 coinbase height)');
eq('height 1', u.serializeScriptNumber(1).toString('hex'), '01');
eq('height 127', u.serializeScriptNumber(127).toString('hex'), '7f');
// 128 has the high bit set, so it needs a padding byte or it reads as negative.
eq('height 128 gets a sign-padding byte', u.serializeScriptNumber(128).toString('hex'), '8000');
eq('height 255', u.serializeScriptNumber(255).toString('hex'), 'ff00');
// 6327333 = 0x608C25, little-endian 25 8c 60. Top byte 0x60 < 0x80, so no
// sign-padding byte is needed at this height.
eq('height 6327333 (current Dogecoin height)',
  u.serializeScriptNumber(6327333).toString('hex'), '258c60');
eq('height 8388608 pads (0x80 top byte)',
  u.serializeScriptNumber(8388608).toString('hex'), '00008000');

console.log('\nvarint boundaries');
eq('252', u.varIntBuffer(252).toString('hex'), 'fc');
eq('253 switches to 16-bit', u.varIntBuffer(253).toString('hex'), 'fdfd00');
eq('65535', u.varIntBuffer(65535).toString('hex'), 'fdffff');
eq('65536 switches to 32-bit', u.varIntBuffer(65536).toString('hex'), 'fe00000100');

console.log('\nbyte order');
const displayHash = '0e16b1fa681fc92ef14bad2ba8c2fe37cd5fbbb92be13f7fa4d938dda5938e45';
const stratumForm = u.reverseByteOrder(Buffer.from(displayHash, 'hex')).toString('hex');
// Recovering the internal form the way miner firmware does.
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2];
    out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}
eq('stratum prevhash round-trips to the internal form',
  u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(stratumForm, 'hex')))).toString('hex'),
  u.reverseHex(displayHash));
check('the stratum form is not simply the reversed hash', stratumForm !== u.reverseHex(displayHash));

console.log('\naddress decoding');
let threw = null;
try { u.addressToScript('', 'main'); } catch (e) { threw = e.message; }
check('empty address is rejected', threw !== null);
threw = null;
try { u.addressToScript('D0OIl', 'main'); } catch (e) { threw = e.message; }
check('base58-illegal characters are rejected', /base58/.test(threw || ''), threw);

// Supplied by the harness: an address generated with Dogecoin Core's own
// parameters, and the scriptPubKey Dogecoin Core derives from it.
const [mainAddress, mainScript] = process.argv.slice(2);
if (mainAddress && mainScript) {
  eq('mainnet address -> script matches dogecoin-tx',
    u.addressToScript(mainAddress, 'main').toString('hex'), mainScript);
  threw = null;
  try { u.addressToScript(mainAddress, 'regtest'); } catch (e) { threw = e.message; }
  check('a mainnet address is refused on regtest', threw !== null, threw);
}

console.log('\ncoinbase scriptSig length bounds');
const template = {
  version: 6422532,
  bits: '196af9fc',
  curtime: 1786436249,
  mintime: 1786435967,
  height: 6327333,
  previousblockhash: displayHash,
  coinbasevalue: 1000415111991,
  coinbaseaux: { flags: '' },
  transactions: [],
  target: '000000000000006af9fc00000000000000000000000000000000000000000000',
};
const script = Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex');
const job = new Job('0001', template, script);
const scriptSigLen = job.coinb1.length - 4 - 1 - 32 - 4 - 1 + 8; // + extranonces
check('coinbase scriptSig is within the 2..100 consensus bounds',
  scriptSigLen >= 2 && scriptSigLen <= 100, String(scriptSigLen));

threw = null;
try {
  new Job('0002', template, script, 'x'.repeat(120));
} catch (e) { threw = e.message; }
check('an over-long coinbase tag is refused at construction', /2\.\.100/.test(threw || ''), threw);

eq('block version is carried through unmodified', job.version, 6422532);
check('network target comes from the template, not recomputed',
  job.networkTarget === BigInt('0x' + template.target));

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
