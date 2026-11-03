// Web Push with no npm packages: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291, RFC 8188).
'use strict';

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const pad32 = (buf) => (buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]));

/** New VAPID key pair as base64url: raw 65-byte public point, raw 32-byte private scalar (the web-push npm format). */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

/** {publicKey, privateKey, subject} -> object ready for vapidHeader(). Throws on malformed keys. */
function makeVapid({ publicKey, privateKey, subject }) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a base64url 65-byte uncompressed P-256 point');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: b64u(pad32(fromB64u(privateKey))) },
  });
  if (!/^(mailto:|https:)/.test(subject || '')) throw new Error('VAPID subject must start with mailto: or https:');
  return { publicKey: b64u(pub), key, subject };
}

/** Authorization header value for one push endpoint. */
function vapidHeader(endpoint, vapid, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const RECORD_SIZE = 4096;

/** Encrypt a payload for one subscription (keys.p256dh, keys.auth as base64url). Returns the request body. */
function encrypt(payload, p256dh, auth, fixed = {}) { // `fixed` pins salt and key for the RFC 8291 test vector only
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  if (plain.length + 16 > RECORD_SIZE - 86) throw new Error('Push payload too large');

  const as = crypto.createECDH('prime256v1');
  if (fixed.asPrivateKey) as.setPrivateKey(fromB64u(fixed.asPrivateKey)); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const salt = fixed.salt ? fromB64u(fixed.salt) : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/**
 * Send one push. sub = {endpoint, p256dh, auth}.
 * Resolves {ok, status, gone}; gone = the subscription no longer exists and should be deleted.
 */
async function sendPush(sub, payload, vapid, { ttl = 3600, urgency = 'high', timeoutMs = 10000 } = {}) {
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: vapidHeader(sub.endpoint, vapid),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.arrayBuffer().catch(() => {});
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// Browsers' push services. The server POSTs to whatever endpoint a client registers, so only these hosts
// are accepted; anything else would let a client point the server at internal addresses.
const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', '.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

function validEndpoint(endpoint, { allowAny = false, hosts = DEFAULT_PUSH_HOSTS } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (allowAny) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return hosts.some((s) => (s.startsWith('.') ? h.endsWith(s) && h.length > s.length : h === s));
}

module.exports = { generateVapidKeys, makeVapid, vapidHeader, encrypt, sendPush, validEndpoint, DEFAULT_PUSH_HOSTS, b64u, fromB64u };
