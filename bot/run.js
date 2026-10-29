// Crypto Control – automat transz. Uruchamiane co ~10 minut przez GitHub Actions (.github/workflows/bot.yml).
// Ustawienia (pole botCfg) i stan (botState) są w Firestore zaszyfrowane kluczem BOT_KEY (AES-256-GCM) –
// w chmurze nie ma jawnych kwot. Jawne jest tylko botBeat: czas ostatniego przebiegu, tryb i ewentualny błąd.
// Repozytorium jest publiczne, więc logi GitHub Actions są widoczne dla wszystkich: NIE wypisujemy kwot, cen ani sald.
'use strict';
const crypto = require('crypto');
const {runBot, trendUp} = require('./core.js');
const {RevX} = require('./revx.js');
const {Paper, dailyCloses} = require('./paper.js');

const SA = JSON.parse(process.env.FIREBASE_SA || '{}');
const BOT_KEY = Buffer.from((process.env.BOT_KEY || '').trim(), 'base64');
const REVX_API_KEY = (process.env.REVX_API_KEY || '').trim();
const REVX_PRIVATE_KEY = process.env.REVX_PRIVATE_KEY || '';
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE || '').trim();
// twardy limit po stronie serwera: tryb na żywo odmówi pracy z budżetem wyższym niż ten sekret (ochrona przed podmianą ustawień)
const MAX_BUDGET = +(process.env.BOT_MAX_BUDGET || '').trim() || 0;
// opcjonalnie: tylko konto o tym identyfikatorze (Ustawienia aplikacji pokazują go w zakładce Automat)
const ONLY_UID = (process.env.BOT_UID || '').trim();
const VAPID_PUBLIC = 'BDR7TxxUAkK0iNQV02R0rofQPxN3gxKPqwBq0n9DMEv9U6z9mtZbByvlyI3MImPkjtUrfzXkn8Y40MSHRmX7xHI';
const VERSION = 1;

const box = require('./box.js');
// AAD = identyfikator konta + nazwa pola: zaszyfrowanych danych nie da się przenieść do innego dokumentu ani zamienić polami
const enc = (obj, aad) => box.enc(BOT_KEY, obj, aad), dec = (s, aad) => box.dec(BOT_KEY, s, aad);

// ---------- Firestore (konto serwisowe, jak w alerts/check.js) ----------
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const body = b64u(JSON.stringify({iss: SA.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: SA.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600}));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(SA.private_key));
  const r = await fetch(SA.token_uri || 'https://oauth2.googleapis.com/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}`})});
  const d = await r.json();
  if (!d.access_token) throw new Error('Token Google nieudany');
  return d.access_token;
}
const FS = () => `https://firestore.googleapis.com/v1/projects/${SA.project_id}/databases/(default)/documents`;

async function patch(auth, docName, fields) {
  const url = `${docName.replace(/^projects/, 'https://firestore.googleapis.com/v1/projects')}?${Object.keys(fields).map(f => 'updateMask.fieldPaths=' + f).join('&')}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {method: 'PATCH', headers: {...auth, 'content-type': 'application/json'},
      body: JSON.stringify({fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, {stringValue: v}]))})}).catch(() => null);
    if (r?.ok) return true;
    await new Promise(z => setTimeout(z, 1500 * (i + 1)));
  }
  throw new Error('Zapis stanu w chmurze nieudany');
}

async function push(subs, msgs) {
  if (!VAPID_PRIVATE || !subs.length || !msgs.length) return;
  const webpush = require('web-push');
  webpush.setVapidDetails('https://kowals96.github.io/crypto-control/', VAPID_PUBLIC, VAPID_PRIVATE);
  // przy wielu zdarzeniach w jednym przebiegu: jedno zbiorcze powiadomienie
  const list = msgs.length > 3 ? [{title: `Automat: ${msgs.length} zdarzeń`, body: msgs.map(m => m.title).join(' · ').slice(0, 300)}] : msgs;
  for (const m of list) for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify({title: m.title, body: m.body, tag: 'bot-' + Date.now() + Math.random(), url: './#bot'}), {TTL: 6 * 3600}); } catch (e) {}
  }
}
const clean = s => String(s || '').replace(/\d[\d.,]{3,}/g, '…').slice(0, 160);     // bez kwot w jawnym statusie

(async () => {
  if (!SA.client_email) { console.log('Brak FIREBASE_SA – pomijam.'); return; }
  if (BOT_KEY.length !== 32) { console.log('Brak lub zły BOT_KEY – automat nieaktywny.'); return; }
  const auth = {authorization: 'Bearer ' + await accessToken()};
  const list = await (await fetch(`${FS()}/users?pageSize=50&mask.fieldPaths=botCfg&mask.fieldPaths=botState&mask.fieldPaths=alerts`, {headers: auth})).json();
  const docs = (list.documents || []).filter(d => d.fields?.botCfg?.stringValue && (!ONLY_UID || d.name.endsWith('/' + ONLY_UID)));
  let acted = 0;
  for (const doc of docs) {
    const uid = doc.name.split('/').pop();
    const beat = {at: Date.now(), v: VERSION, ok: true, mode: 'off', msg: ''};
    const writeBeat = () => patch(auth, doc.name, {botBeat: JSON.stringify(beat)}).catch(() => {});
    let cfg, root;
    // zgodność wstecz: dane zaszyfrowane przed przypisaniem do konta (AAD bez identyfikatora) odczytujemy raz i zapisujemy już nowym sposobem
    const decAny = (v, f) => { try { return dec(v, uid + ':' + f); } catch (e) { return dec(v, f); } };
    try { cfg = decAny(doc.fields.botCfg.stringValue, 'botCfg'); }
    catch (e) { beat.ok = false; beat.msg = 'Nie mogę odczytać ustawień – BOT_KEY w GitHubie nie pasuje do klucza w aplikacji.'; await writeBeat(); continue; }
    try { root = doc.fields.botState?.stringValue ? decAny(doc.fields.botState.stringValue, 'botState') : {}; }
    catch (e) { beat.ok = false; beat.msg = 'Nie mogę odczytać stanu automatu (zmieniony BOT_KEY?).'; await writeBeat(); continue; }
    beat.mode = cfg.mode || 'off';
    let subs = [];
    try { subs = (JSON.parse(doc.fields.alerts?.stringValue || '{}').subs || []).filter(s => s?.endpoint); } catch (e) {}
    const msgs = [];
    const notify = (title, body) => { if (cfg.notify !== false) msgs.push({title, body}); };
    const save = async () => { await patch(auth, doc.name, {botState: enc(root, uid + ':botState')}); };

    // połączenie z Revolut X (sprawdzane też w trybie próbnym, żeby kreator mógł pokazać „działa”)
    let rx = null;
    if (REVX_API_KEY && REVX_PRIVATE_KEY) {
      try {
        rx = new RevX({apiKey: REVX_API_KEY, privateKey: REVX_PRIVATE_KEY});
        if (!root.revx || Date.now() - (root.revx.at || 0) > 6 * 3600000 || !root.revx.ok || cfg.mode === 'live') {
          const bal = await rx.balances();
          root.revx = {at: Date.now(), ok: true, msg: '', bal: bal.filter(b => ['USD', 'USDC', 'EUR', 'GBP', 'USDT'].includes(b.cur) || (cfg.coins || []).some(c => c.sym === b.cur))};
        }
      } catch (e) { root.revx = {at: Date.now(), ok: false, msg: e.status === 401 ? 'Revolut X odrzucił klucz (401) – sprawdź REVX_API_KEY i klucz publiczny w Revolut X.' : e.status === 403 ? 'Revolut X: brak uprawnień klucza (403) – klucz musi mieć prawo do handlu.' : clean(e.message)}; rx = null; }
    } else root.revx = {at: Date.now(), ok: false, msg: 'Brak sekretów REVX_API_KEY / REVX_PRIVATE_KEY w GitHubie.'};

    // trend: raz dziennie na monetę (Binance, dane publiczne)
    root.trend = root.trend || {};
    const today = new Date().toISOString().slice(0, 10), trend = {};
    for (const c of cfg.coins || []) {
      if (!/^[A-Z0-9]{2,10}$/.test(c.sym)) continue;
      if (root.trend[c.sym]?.d !== today) { try { const t = trendUp(await dailyCloses(c.sym)); if (t) root.trend[c.sym] = {d: today, ...t}; } catch (e) {} }
      if (root.trend[c.sym]) trend[c.sym] = root.trend[c.sym];
    }

    const jobs = [];
    if (cfg.mode === 'paper') jobs.push('paper');
    if (cfg.mode === 'live' || (root.live && Object.values(root.live.coins || {}).some(c => c.pend || c.lots?.length))) jobs.push('live');
    let errors = [];
    for (const job of jobs) {
      root[job] = root[job] || {};
      const st = root[job];
      let ex;
      if (job === 'paper') { st.book = st.book || {}; ex = new Paper(st.book, cfg.quote || 'USD', +cfg.budget || 0); try { await ex.sync(); } catch (e) { errors.push('ceny próbne: ' + e.message); continue; } }
      else { if (!rx) { errors.push(root.revx?.msg || 'Brak połączenia z Revolut X'); continue; } ex = rx; }
      // „stary” stan (np. transze z trybu na żywo po przełączeniu na próbny): tylko rozliczenie sprzedaży, bez zakupów i bez poleceń
      // polecenia (np. „Sprzedaj wszystko” dla transz z trybu na żywo) działają tylko w stanie trybu, w którym je wydano – pilnuje tego core.js
      let jobCfg = job === cfg.mode ? cfg : {...cfg, mode: 'off'};
      if (job === 'live' && cfg.mode === 'live' && !(MAX_BUDGET > 0 && +cfg.budget <= MAX_BUDGET)) {
        errors.push(MAX_BUDGET > 0 ? 'Budżet w aplikacji jest wyższy niż sekret BOT_MAX_BUDGET w GitHubie – nowe zakupy wstrzymane.' : 'Ustaw w GitHubie sekret BOT_MAX_BUDGET (najwyższy dozwolony budżet automatu) – bez niego tryb na żywo nie kupuje.');
        jobCfg = {...cfg, mode: 'off'};
      }
      try {
        const r = await runBot({ex, cfg: jobCfg, st, job, notify: (t, b) => notify(job === 'paper' ? '[próba] ' + t : t, b), save, trend});
        errors.push(...r.errors); acted += r.events.length;
      } catch (e) { errors.push(clean(e.message)); }
      if (job === 'paper') {
        const refs = new Set(); Object.values(st.coins || {}).forEach(c => { if (c.pend?.oid) refs.add(c.pend.oid); (c.lots || []).forEach(l => { if (l.sellOid) refs.add(l.sellOid); if (l.buyOid) refs.add(l.buyOid); }); });
        ex.prune(refs);
      }
    }
    root.updatedAt = Date.now();
    await save();
    beat.ok = !errors.length; beat.msg = errors.length ? clean(errors.join(' · ')) : '';
    beat.revx = root.revx?.ok ? 'ok' : (REVX_API_KEY ? 'error' : 'none');
    beat.halt = !!(root.live?.halt || root.paper?.halt);
    beat.maxBudget = MAX_BUDGET > 0;
    beat.uid = !!ONLY_UID;
    await writeBeat();
    await push(subs, msgs);
  }
  console.log(`Automat: ${docs.length} konto(a), zdarzeń: ${acted}.`);
})().catch(e => { console.error('Automat: błąd', e.status || '', e.message ? e.message.replace(/\d[\d.,]{3,}/g, '…').slice(0, 120) : ''); process.exit(1); });

