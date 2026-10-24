/* The drop box's lock: the page's WebCrypto code (src/dropcrypto.js) and the helper's Node tool
   (tools/speakd/crypt.mjs) must read each other's files, and a wrong key or a changed byte must fail.

     node tools/test/test_drop.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'dropcrypto.js'), 'utf8');
const TOOL = path.join(ROOT, 'tools', 'speakd', 'crypt.mjs');

let fails = 0, passes = 0;
const ok = (name, cond) => { if (cond) passes++; else { fails++; console.log('  FAIL ' + name); } };
const eq = (name, a, b) => ok(name + ' (' + JSON.stringify(a).slice(0, 60) + ' vs ' + JSON.stringify(b).slice(0, 60) + ')', JSON.stringify(a) === JSON.stringify(b));

let api = null;
const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Uint8Array, Promise, String, Array, JSON };
sandbox.window = sandbox;
sandbox.__dropTest = (a) => { api = a; };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'dropcrypto.js' });
ok('the page code loaded', api && api.keyOf && api.seal && api.open);

const tool = (mode, keyHex, bytes) => spawnSync(process.execPath, [TOOL, mode, keyHex], { input: Buffer.from(bytes), maxBuffer: 64 * 1024 * 1024 });

const token = 'github_pat_TESTTESTTEST_not_a_real_token';
const key = await api.keyOf(token);
const keyHex = api.hex(key);
eq('the key is 32 bytes', key.length, 32);
eq('the key is stable for a token', api.hex(await api.keyOf(token)), keyHex);
ok('another token gives another key', api.hex(await api.keyOf(token + 'x')) !== keyHex);
/* fixed vector: HKDF-SHA256 computed independently with node:crypto */
const ref = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), Buffer.from('speak-dropbox-v1'), Buffer.from('aes-256-gcm'), 32)).toString('hex');
eq('the page derives the same key as node:crypto HKDF', keyHex, ref);

const sample = Buffer.from('The words: मैं yeh bol raha hoon. ' + 'x'.repeat(100000));
const sealed = await api.seal(key, new Uint8Array(sample));
eq('sealed = 12 + data + 16 bytes', sealed.length, 12 + sample.length + 16);
ok('the sealed bytes are not the text', !Buffer.from(sealed).includes(Buffer.from('bol raha hoon')));
const back = tool('dec', keyHex, sealed);
eq('node opens what the page sealed', back.status, 0);
ok('and it is the same bytes', Buffer.compare(back.stdout, sample) === 0);

const sealedByNode = tool('enc', keyHex, sample);
eq('node seals', sealedByNode.status, 0);
const opened = await api.open(key, new Uint8Array(sealedByNode.stdout));
ok('the page opens what node sealed', Buffer.compare(Buffer.from(opened), sample) === 0);

const otherKey = await api.keyOf('another token');
let wrong = false;
try { await api.open(otherKey, sealed); } catch { wrong = true; }
ok('the page refuses a wrong key', wrong);
eq('node refuses a wrong key', tool('dec', api.hex(otherKey), sealed).status, 2);
const flipped = Buffer.from(sealed); flipped[50] ^= 1;
let tampered = false;
try { await api.open(key, new Uint8Array(flipped)); } catch { tampered = true; }
ok('the page refuses a changed byte', tampered);
eq('node refuses a changed byte', tool('dec', keyHex, flipped).status, 2);
eq('node refuses something too short', tool('dec', keyHex, Buffer.from('abc')).status, 2);
eq('node refuses a bad key', tool('enc', 'nothex', sample).status, 64);

const empty = await api.seal(key, new Uint8Array(0));
eq('an empty file seals to 28 bytes', empty.length, 28);
eq('and opens to nothing', (await api.open(key, empty)).length, 0);
const twice = [api.hex(await api.seal(key, new Uint8Array([1, 2, 3]))), api.hex(await api.seal(key, new Uint8Array([1, 2, 3])))];
ok('the same data seals differently each time (a fresh IV)', twice[0] !== twice[1]);

const b = new Uint8Array(70000).map((_, i) => i % 251);
eq('base64 round trip of 70 KB', api.hex(api.fromB64(api.toB64(b))), api.hex(b));
eq('base64 matches Buffer', api.toB64(b), Buffer.from(b).toString('base64'));

console.log(passes + ' checks passed' + (fails ? ', ' + fails + ' FAILED' : ''));
process.exit(fails ? 1 : 0);
