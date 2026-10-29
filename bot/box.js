// Szyfrowanie ustawień i stanu automatu: AES-256-GCM, zgodne z WebCrypto w aplikacji (szyfrogram || tag 16 B, AAD = nazwa pola).
'use strict';
const crypto = require('crypto');
function enc(key, obj, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return `b1.${iv.toString('base64')}.${ct.toString('base64')}`;
}
function dec(key, s, aad) {
  const [v, ivB, ctB] = String(s).split('.');
  if (v !== 'b1') throw new Error('nieznany format');
  const iv = Buffer.from(ivB, 'base64'), all = Buffer.from(ctB, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad)); d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'));
}
module.exports = {enc, dec};
