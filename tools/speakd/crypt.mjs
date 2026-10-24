// AES-256-GCM for the drop box, the same lock the pages use (src/dropcrypto.js).
//   node crypt.mjs enc <key as 64 hex digits>   bytes on stdin -> IV(12) + ciphertext + tag(16) on stdout
//   node crypt.mjs dec <key as 64 hex digits>   the same, back; exits 2 if the key is wrong or a byte changed
import crypto from 'node:crypto';

const [mode, keyHex] = process.argv.slice(2);
if (!['enc', 'dec'].includes(mode) || !/^[0-9a-f]{64}$/i.test(keyHex || '')) {
  console.error('usage: node crypt.mjs enc|dec <64 hex digits>   (bytes on stdin, bytes on stdout)');
  process.exit(64);
}
const key = Buffer.from(keyHex, 'hex');
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const data = Buffer.concat(chunks);

try {
  if (mode === 'enc') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(data), c.final()]);
    process.stdout.write(Buffer.concat([iv, ct, c.getAuthTag()]));
  } else {
    if (data.length < 12 + 16) throw new Error('too short');
    const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    d.setAuthTag(data.subarray(data.length - 16));
    process.stdout.write(Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]));
  }
} catch (e) {
  console.error('crypt: ' + e.message);
  process.exit(2);
}
