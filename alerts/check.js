// Crypto Control – powiadomienia w tle.
// Uruchamiane co ~10 minut przez GitHub Actions (.github/workflows/alerts.yml).
// Czyta progi cenowe i terminy zapisane przez aplikację (pole "alerts" w Firestore – bez kwot portfela),
// sprawdza ceny i wysyła powiadomienia push (Web Push, VAPID) na zapisane urządzenia.
'use strict';
const crypto = require('crypto');
const webpush = require('web-push');

const VAPID_PUBLIC = 'BDR7TxxUAkK0iNQV02R0rofQPxN3gxKPqwBq0n9DMEv9U6z9mtZbByvlyI3MImPkjtUrfzXkn8Y40MSHRmX7xHI';
const SA = JSON.parse(process.env.FIREBASE_SA || '{}');
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE || '').trim();
if (!SA.client_email || !VAPID_PRIVATE) { console.log('Brak sekretów FIREBASE_SA / VAPID_PRIVATE – pomijam.'); process.exit(0); }
webpush.setVapidDetails('https://kowals96.github.io/crypto-control/', VAPID_PUBLIC, VAPID_PRIVATE);

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const body = b64u(JSON.stringify({iss: SA.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: SA.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600}));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(SA.private_key));
  const r = await fetch(SA.token_uri || 'https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}`})});
  const d = await r.json();
  if (!d.access_token) throw new Error('Token Google: ' + JSON.stringify(d));
  return d.access_token;
}
const FS = `https://firestore.googleapis.com/v1/projects/${SA.project_id}/databases/(default)/documents`;

async function prices(pairs) {
  const out = {};
  if (!pairs.length) return out;
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com']) {
    try {
      const r = await fetch(`${host}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`);
      if (!r.ok) continue;
      (await r.json()).forEach(t => { out[t.symbol] = +t.price; });
      if (Object.keys(out).length) return out;
    } catch (e) {}
  }
  for (const p of pairs) {          // pojedynczo – gdy któraś para nie istnieje, zapytanie zbiorcze się nie udaje
    try { const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${p}`); if (r.ok) out[p] = +(await r.json()).price; } catch (e) {}
  }
  return out;
}
function warsawNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false})
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

(async () => {
  const token = await accessToken();
  const auth = {authorization: 'Bearer ' + token};
  const list = await (await fetch(`${FS}/users?pageSize=50&mask.fieldPaths=alerts&mask.fieldPaths=alertState`, {headers: auth})).json();
  const docs = (list.documents || []).filter(d => d.fields?.alerts?.stringValue);
  const now = warsawNow();
  for (const doc of docs) {
    let A, S;
    try { A = JSON.parse(doc.fields.alerts.stringValue); } catch (e) { continue; }
    try { S = JSON.parse(doc.fields.alertState?.stringValue || '{}'); } catch (e) { S = {}; }
    S.rules = S.rules || {}; S.dead = S.dead || [];
    const subs = (A.subs || []).filter(s => s?.endpoint && !S.dead.includes(s.endpoint));
    if (!subs.length) continue;
    const rules = A.rules || [];
    const px = await prices([...new Set(rules.filter(r => r.pair).map(r => r.pair))]);
    const fire = [];
    const live = new Set();
    for (const r of rules) {
      live.add(r.id);
      const st = S.rules[r.id] || {armed: true};
      if (r.pair && r.price > 0) {
        const p = px[r.pair];
        if (!(p > 0)) continue;
        const hit = r.dir === 'below' ? p <= r.price : p >= r.price;
        const rearm = r.dir === 'below' ? p > r.price * 1.02 : p < r.price * 0.98;
        if (hit && st.armed) { fire.push({...r, body: r.body + ` Cena teraz: $${p < 1 ? p.toPrecision(4) : p.toLocaleString('pl-PL', {maximumFractionDigits: 2})}.`}); st.armed = false; st.at = Date.now(); }
        else if (!hit && rearm) st.armed = true;
      } else if (r.at) {
        if (now >= r.at && !st.fired && now < r.until) { fire.push(r); st.fired = Date.now(); }
      }
      S.rules[r.id] = st;
    }
    Object.keys(S.rules).forEach(id => { if (!live.has(id)) delete S.rules[id]; });
    for (const n of fire) {
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, JSON.stringify({title: n.title, body: n.body, tag: n.id, url: './'}), {TTL: 3600});
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) S.dead.push(sub.endpoint);
          else console.log('push error', e.statusCode, e.body);
        }
      }
      console.log('wysłano:', n.title);
    }
    S.checkedAt = Date.now();
    S.dead = [...new Set(S.dead)].slice(-20);
    await fetch(`${doc.name.replace(/^projects/, 'https://firestore.googleapis.com/v1/projects')}?updateMask.fieldPaths=alertState`, {method: 'PATCH', headers: {...auth, 'content-type': 'application/json'},
      body: JSON.stringify({fields: {alertState: {stringValue: JSON.stringify(S)}}})});
  }
  console.log(`Sprawdzono ${docs.length} konto(a), ${now}.`);
})().catch(e => { console.error(e); process.exit(1); });
