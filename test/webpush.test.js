// Web Push crypto. Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wp = require('../lib/webpush.js');

// What a browser does with a push message (RFC 8291 receiver side).
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync('sha256', uaEcdh.computeSecret(asPublic), authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString();
}

test('encryption matches the RFC 8291 worked example', () => {
  const body = wp.encrypt('When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: 'DGv6ra1nlYgDCS1FRnbzlw', asPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' });
  assert.equal(wp.b64u(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a subscriber can decrypt what we send', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const payload = JSON.stringify({ title: 'Power off at 18:00', body: 'Charge your phone now.' });
  const body = wp.encrypt(payload, wp.b64u(ua.getPublicKey()), wp.b64u(auth));
  assert.equal(decrypt(body, ua, auth), payload);
});

test('VAPID header is an ES256 JWT that verifies with the public key', () => {
  const keys = wp.generateVapidKeys();
  const v = wp.makeVapid({ ...keys, subject: 'mailto:ops@example.org' });
  const h = wp.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', v, Date.UTC(2026, 10, 3));
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:ops@example.org');
  const pub = wp.fromB64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('only browser push services are accepted as endpoints', () => {
  assert.ok(wp.validEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(wp.validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(wp.validEndpoint('https://web.push.apple.com/abc'));
  assert.ok(wp.validEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc'));
  assert.equal(wp.validEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(wp.validEndpoint('https://127.0.0.1/x'), false);
  assert.equal(wp.validEndpoint('https://evil.example/fcm.googleapis.com'), false);
  assert.equal(wp.validEndpoint('https://fcm.googleapis.com.evil.example/x'), false);
  assert.equal(wp.validEndpoint('https://fcm.googleapis.com:8443/x'), false);
});
