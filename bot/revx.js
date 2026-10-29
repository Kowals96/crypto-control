// Revolut X – klient REST (podpis Ed25519 jak w oficjalnym SDK revolut-engineering/revolut-x-api).
// Używane tylko: pary, ceny, saldo, zlecenia limit (kupno/sprzedaż), sprawdzenie i anulowanie zlecenia.
// Wypłat nie ma w API, a automat i tak by ich nie wywołał.
'use strict';
const {createPrivateKey, sign} = require('crypto');

class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function loadKey(pem) {
  let s = String(pem || '').trim().replace(/\\n/g, '\n');
  if (!/BEGIN/.test(s)) s = `-----BEGIN PRIVATE KEY-----\n${s.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  return createPrivateKey(s);
}

class RevX {
  constructor({apiKey, privateKey, base = 'https://revx.revolut.com'}) {
    this.apiKey = String(apiKey || '').trim();
    this.key = loadKey(privateKey);
    this.base = base;
    this.pairs = null;
  }
  async req(method, path, params, body) {
    const qs = params ? Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    const bodyStr = body ? JSON.stringify(body) : '';
    const full = `/api/1.0${path}`;
    for (let attempt = 0; ; attempt++) {
      const ts = String(Date.now());
      const sig = sign(null, Buffer.from(`${ts}${method}${full}${qs}${bodyStr}`, 'utf-8'), this.key).toString('base64');
      let r;
      try {
        r = await fetch(`${this.base}${full}${qs ? '?' + qs : ''}`, {method, headers: {'X-Revx-API-Key': this.apiKey, 'X-Revx-Timestamp': ts, 'X-Revx-Signature': sig,
          'Content-Type': 'application/json', Accept: 'application/json'}, body: bodyStr || undefined, signal: AbortSignal.timeout(15000)});
      } catch (e) {
        // GET można bezpiecznie powtórzyć; POST nie – zlecenie odzyskamy po client_order_id w kolejnym przebiegu
        if (method === 'GET' && attempt < 2) { await new Promise(z => setTimeout(z, 1000 * (attempt + 1))); continue; }
        throw new ApiError(0, 'Brak połączenia z Revolut X');
      }
      if (r.status === 204) return {};
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : {};
      if ((r.status >= 500 || r.status === 429) && method === 'GET' && attempt < 2) { await new Promise(z => setTimeout(z, 1500 * (attempt + 1))); continue; }
      let msg = ''; try { msg = JSON.parse(text).message || ''; } catch (e) {}
      throw new ApiError(r.status, msg || `HTTP ${r.status}`);
    }
  }
  async pairInfo(pair) {
    if (!this.pairs) this.pairs = await this.req('GET', '/configuration/pairs');
    const p = this.pairs[pair.replace('-', '/')];
    if (!p || p.status !== 'active') return null;
    return {baseStep: +p.base_step, quoteStep: +p.quote_step, minBase: +p.min_order_size, minQuote: +p.min_order_size_quote};
  }
  async ticker(pair) {
    const d = await this.req('GET', '/tickers', {symbols: pair});
    const t = (d.data || []).find(x => x.symbol === pair.replace('-', '/'));
    return t ? {bid: +t.bid, ask: +t.ask, last: +t.last_price} : null;
  }
  async available(cur) {
    const d = await this.req('GET', '/balances');
    const b = (Array.isArray(d) ? d : d.data || []).find(x => x.currency === cur);
    return b ? +b.available : 0;
  }
  async balances() {
    const d = await this.req('GET', '/balances');
    return (Array.isArray(d) ? d : d.data || []).filter(b => +b.total > 0).map(b => ({cur: b.currency, available: +b.available, total: +b.total}));
  }
  static mapOrder(o) {
    const fq = +o.filled_quantity || 0, avg = +o.average_fill_price || 0;
    const fa = o.filled_amount != null && o.filled_amount !== '' ? +o.filled_amount : fq * (avg || +o.price || 0);
    return {oid: o.id, cid: o.client_order_id, status: o.status, side: o.side, price: +o.price, qty: +o.quantity, filledQty: fq, filledAmount: fa, avgPx: avg || (fq ? fa / fq : 0),
      fee: +o.total_fee || 0, feeCur: o.fee_currency || null};
  }
  async getOrder(oid) { return RevX.mapOrder((await this.req('GET', `/orders/${encodeURIComponent(oid)}`)).data); }
  async findByCid(pair, cid) {
    if (!cid) return null;
    let cursor;
    for (let i = 0; i < 5; i++) {
      const d = await this.req('GET', '/orders/active', {symbols: pair, limit: 300, cursor});
      const o = (d.data || []).find(x => x.client_order_id === cid); if (o) return RevX.mapOrder(o);
      cursor = d.metadata?.next_cursor; if (!cursor) break;
    }
    cursor = undefined;
    for (let i = 0; i < 5; i++) {
      const d = await this.req('GET', '/orders/historical', {symbols: pair, limit: 1900, cursor, start_date: Date.now() - 6.9 * 86400000, end_date: Date.now()});
      const o = (d.data || []).find(x => x.client_order_id === cid); if (o) return RevX.mapOrder(o);
      cursor = d.metadata?.next_cursor; if (!cursor) break;
    }
    return null;
  }
  async place({cid, pair, side, price, base, postOnly}) {
    const d = await this.req('POST', '/orders', null, {client_order_id: cid, symbol: pair, side,
      order_configuration: {limit: {base_size: String(base), price: String(price), execution_instructions: postOnly ? ['post_only'] : ['allow_taker']}}});
    return {oid: d.data?.venue_order_id, state: d.data?.state};
  }
  // anulowanie: błąd 400/404 zwykle znaczy „już wykonane / anulowane” – o tym decyduje wywołujący, sprawdzając stan zlecenia
  async cancel(oid) {
    try { await this.req('DELETE', `/orders/${encodeURIComponent(oid)}`); }
    catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
  }
  async activeIds(pair) {
    const ids = new Set(); let cursor;
    for (let i = 0; i < 10; i++) {
      const d = await this.req('GET', '/orders/active', {symbols: pair, limit: 300, cursor});
      (d.data || []).forEach(o => ids.add(o.id));
      cursor = d.metadata?.next_cursor; if (!cursor) break;
    }
    return ids;
  }
}

module.exports = {RevX, ApiError, loadKey};
