/* The drop box's lock. Recordings from a tablet, and the words that come back, travel through a branch of
   the journal's own repository, which is public. So everything in it is encrypted, and the key is made
   from the journal's sign-in (the token every signed-in device already holds), so there is nothing to
   type, copy or set up: any device that is signed in can lock and unlock, and nobody else can read a byte.

     key     = HKDF-SHA256(token, salt "speak-dropbox-v1", info "aes-256-gcm") -> 32 bytes
     a file  = 12 random bytes (the IV) + AES-256-GCM(ciphertext + 16-byte tag)

   The PC's helper does the same lock with Node (tools/speakd/crypt.mjs), so it is told the key once: a page
   on a Windows PC that is signed in hands it over to the helper at 127.0.0.1 (never anywhere else). A
   tablet never does that. If the sign-in token is ever replaced, the key changes with it, and the PC is
   told the new one the next time the journal is opened there. */
(function () {
  'use strict';

  var subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
  var enc = function (s) { return new TextEncoder().encode(s); };
  var hex = function (u8) { return Array.prototype.map.call(u8, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); };

  function keyOf(token) {
    return subtle.importKey('raw', enc(String(token)), 'HKDF', false, ['deriveBits']).then(function (k) {
      return subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc('speak-dropbox-v1'), info: enc('aes-256-gcm') }, k, 256);
    }).then(function (bits) { return new Uint8Array(bits); });
  }
  var aes = function (key) { return subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']); };
  function seal(key, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return aes(key).then(function (k) { return subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, bytes); }).then(function (ct) {
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(iv, 0);
      out.set(new Uint8Array(ct), 12);
      return out;
    });
  }
  /* rejects if the key is wrong or a byte was changed */
  function open(key, bytes) {
    return aes(key).then(function (k) { return subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, k, bytes.subarray(12)); })
      .then(function (pt) { return new Uint8Array(pt); });
  }
  /* bytes <-> base64, as the GitHub contents API wants it */
  function toB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  }
  function fromB64(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  var api = { keyOf: keyOf, seal: seal, open: open, hex: hex, toB64: toB64, fromB64: fromB64 };
  window.drop = api;
  if (typeof window.__dropTest === 'function') window.__dropTest(api);

  /* A signed-in Windows PC tells its helper the key (once per tab session). Not the Write page, not the
     helper's own address (a different origin that is never signed in), not a phone or tablet. */
  if (typeof document === 'undefined' || !subtle) return;
  var token = '';
  try { token = localStorage.getItem('gh_token') || ''; } catch (e) {}
  if (!token || location.port === '4777' || /^\/admin\//.test(location.pathname) || !/Windows/.test(navigator.userAgent || '')) return;
  try { if (sessionStorage.getItem('drop_key_told') === token.length + ':' + token.slice(-6)) return; } catch (e) {}
  keyOf(token).then(function (key) {
    return fetch('http://127.0.0.1:4777/dropkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: hex(key) }) });
  }).then(function (r) {
    if (r && r.ok) { try { sessionStorage.setItem('drop_key_told', token.length + ':' + token.slice(-6)); } catch (e) {} }
  }, function () {});
})();
