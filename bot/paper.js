// Giełda próbna: prawdziwe ceny (Binance, dane publiczne), zlecenia tylko na niby.
// Zlecenie limit czekające na cenę wykonuje się, gdy w świecach 1-minutowych od jego wystawienia cena dotknęła limitu.
// Zlecenie przecinające rynek wykonuje się od razu po najlepszej cenie, z prowizją jak na Revolut X (0,09%).
'use strict';
const TAKER = 0.0009, MAKER = 0;
const bnSym = pair => pair.split('-')[0] + 'USDT';
// ceny Binance są w USDT – dla EUR/USDC przeliczamy kursem z tej samej giełdy
const FX_PAIR = {EUR: 'EURUSDT', USDC: 'USDCUSDT'};
const step = p => p >= 1000 ? 0.01 : p >= 1 ? 0.0001 : p >= 0.01 ? 0.000001 : 1e-9;

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, {signal: AbortSignal.timeout(15000)}); if (r.ok) return await r.json(); } catch (e) {}
    await new Promise(z => setTimeout(z, 1000 * (i + 1)));
  }
  throw new Error('Brak danych cenowych (Binance)');
}
const BN = 'https://data-api.binance.vision/api/v3';

async function dailyCloses(sym) {
  const d = await getJson(`${BN}/klines?symbol=${sym}USDT&interval=1d&limit=230`);
  return d.map(k => +k[4]);
}

class Paper {
  constructor(book, quote, budget) {
    this.b = book; this.quote = quote;
    book.orders = book.orders || {};
    book.bal = book.bal || {};
    if (book.funded == null) { book.funded = budget; book.bal[quote] = (book.bal[quote] || 0) + budget; }
    else if (budget !== book.funded) { book.bal[quote] = (book.bal[quote] || 0) + (budget - book.funded); book.funded = budget; }
    this.tick = {}; this.fx = null;
  }
  async rate() {           // ile USDT za 1 jednostkę waluty kwotowanej
    if (this.fx != null) return this.fx;
    if (!FX_PAIR[this.quote]) return (this.fx = 1);
    const d = await getJson(`${BN}/ticker/price?symbol=${FX_PAIR[this.quote]}`);
    return (this.fx = +d.price > 0 ? +d.price : 1);
  }
  async pairInfo(pair) {
    const t = await this.ticker(pair);
    return t ? {baseStep: 1e-8, quoteStep: step(t.ask), minBase: 1e-8, minQuote: 1} : null;
  }
  async ticker(pair) {
    if (this.tick[pair]) return this.tick[pair];
    const d = await getJson(`${BN}/ticker/bookTicker?symbol=${bnSym(pair)}`), fx = await this.rate();
    return (this.tick[pair] = {bid: +d.bidPrice / fx, ask: +d.askPrice / fx, last: (+d.bidPrice + +d.askPrice) / 2 / fx});
  }
  // wykonanie czekających zleceń na podstawie świec od ostatniego sprawdzenia
  async sync(now = Date.now()) {
    const open = Object.values(this.b.orders).filter(o => o.status === 'new');
    const pairs = [...new Set(open.map(o => o.pair))];
    for (const pair of pairs) {
      const since = Math.min(...open.filter(o => o.pair === pair).map(o => o.checked));
      const span = now - since, interval = span > 15 * 3600000 ? '15m' : '1m';
      const k = await getJson(`${BN}/klines?symbol=${bnSym(pair)}&interval=${interval}&startTime=${since}&limit=1000`), fx = await this.rate();
      for (const o of open.filter(x => x.pair === pair)) {
        const after = k.filter(c => c[0] >= o.checked);           // tylko świece rozpoczęte po wystawieniu / ostatnim sprawdzeniu
        // ostrożnie: samo dotknięcie ceny nie wystarcza – cena musi przebić limit o 0,05%
        const hit = o.side === 'buy' ? after.some(c => +c[3] / fx <= o.price * 0.9995) : after.some(c => +c[2] / fx >= o.price * 1.0005);
        if (hit) this.fill(o, o.price, MAKER);
        o.checked = Math.floor(now / 60000) * 60000;
      }
    }
  }
  fill(o, px, feeRate) {
    const amt = o.qty * px, fee = amt * feeRate;
    const [base, quote] = o.pair.split('-');
    if (o.side === 'buy') { this.b.bal[quote] = (this.b.bal[quote] || 0) - amt - fee; this.b.bal[base] = (this.b.bal[base] || 0) + o.qty; }
    else { this.b.bal[base] = (this.b.bal[base] || 0) - o.qty; this.b.bal[quote] = (this.b.bal[quote] || 0) + amt - fee; }
    Object.assign(o, {status: 'filled', filledQty: o.qty, filledAmount: amt, fee, feeCur: fee ? quote : null, avgPx: px});
  }
  async available(cur) {
    const reserved = Object.values(this.b.orders).filter(o => o.status === 'new' && o.side === 'buy' && o.pair.endsWith('-' + cur)).reduce((a, o) => a + o.qty * o.price, 0);
    return (this.b.bal[cur] || 0) - reserved;
  }
  async getOrder(oid) { const o = this.b.orders[oid]; if (!o) throw new Error('Brak zlecenia (tryb próbny)'); return {...o}; }
  async findByCid(pair, cid) { return Object.values(this.b.orders).find(o => o.cid === cid) || null; }
  async place({cid, pair, side, price, base, postOnly}) {
    const t = await this.ticker(pair), oid = 'p-' + cid;
    // limit: Date.now() zaokrąglone w dół do minuty → świeca, w której wystawiono zlecenie, liczy się dopiero od następnej
    const o = {oid, cid, pair, side, price: +price, qty: +base, status: 'new', filledQty: 0, filledAmount: 0, fee: 0, feeCur: null, avgPx: 0, checked: Math.ceil(Date.now() / 60000) * 60000, at: Date.now()};
    this.b.orders[oid] = o;
    const crosses = side === 'buy' ? +price >= t.ask : +price <= t.bid;
    if (crosses) { if (postOnly) o.status = 'rejected'; else this.fill(o, side === 'buy' ? t.ask : t.bid, TAKER); }
    return {oid, state: o.status};
  }
  async cancel(oid) { const o = this.b.orders[oid]; if (o && o.status === 'new') o.status = 'cancelled'; }
  async activeIds(pair) { return new Set(Object.values(this.b.orders).filter(o => o.pair === pair && o.status === 'new').map(o => o.oid)); }
  // porządek: usuwamy stare zakończone zlecenia, do których stan automatu już się nie odwołuje
  prune(refs) {
    const done = Object.values(this.b.orders).filter(o => o.status !== 'new' && !refs.has(o.oid)).sort((a, b) => a.at - b.at);
    done.slice(0, Math.max(0, done.length - 200)).forEach(o => delete this.b.orders[o.oid]);
  }
}

module.exports = {Paper, dailyCloses, getJson};
