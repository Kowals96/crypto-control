// Crypto Control – automat transz: logika strategii (bez sieci; giełda przekazywana jako obiekt).
// Zasady (jak w symulacji):
// - pula monety = budżet × udział + zrealizowany zysk tej monety (zysk pracuje dalej); dodatkowo limit całkowity na wszystkie monety
// - brak kupionych transz → pierwsza transza od razu po bieżącej cenie
// - są transze → kolejna czeka jako zlecenie limit na giełdzie, o `steps[n-1]`% poniżej NAJNIŻSZEJ ceny zakupu
// - każda transza ma wystawione zlecenie sprzedaży limit przy +tp% od własnej (efektywnej) ceny zakupu
// - nigdy nie sprzedajemy poniżej ceny zakupu (poza poleceniem „Sprzedaj wszystko” i ceną wyjścia ustawioną przez właściciela)
// - automat sprzedaje wyłącznie ilości, które sam kupił – nie dotyka reszty salda
// - filtr trendu / limit ceny / pauza blokują tylko NOWE zakupy; zlecenia sprzedaży zostają
// - anulowanie zlecenia uznajemy dopiero po potwierdzeniu przez giełdę; do tego czasu nic nie zastępujemy
'use strict';

const MAX_ORDERS_DAY = 40;          // bezpiecznik: więcej nowych zleceń dziennie = coś jest nie tak → wstrzymanie
const MIN_QUOTE = 10;               // minimalna transza w walucie kwotowanej (USD/USDC/EUR)
const FINAL = new Set(['filled', 'cancelled', 'rejected']);

const decimals = step => { const s = String(step); if (/e-/.test(s)) return +s.split('e-')[1]; const f = s.split('.')[1] || ''; return f.replace(/0+$/, '').length; };
const floorTo = (x, step) => { const d = decimals(step), st = +step; return (Math.floor(x / st + 1e-9) * st).toFixed(d); };
const ceilTo = (x, step) => { const d = decimals(step), st = +step; return (Math.ceil(x / st - 1e-9) * st).toFixed(d); };
const uid = () => require('crypto').randomUUID();
const ymd = t => new Date(t).toISOString().slice(0, 10);
const fmt = (n, d) => { if (d == null) d = n >= 1000 ? 0 : n >= 1 ? 2 : 5; return Number(n).toLocaleString('pl-PL', {minimumFractionDigits: d, maximumFractionDigits: d}); };

class Halt extends Error {}

function coinState(st, sym) {
  st.coins = st.coins || {};
  return (st.coins[sym] = st.coins[sym] || {lots: [], pend: null, realized: 0, cycles: 0, exited: false, dust: 0});
}

// koszt efektywny transzy z wypełnionego zlecenia kupna (prowizja w walucie bazowej zmniejsza ilość, w kwotowanej podnosi koszt).
// Gdy zlecenie przecięło rynek, a giełda nie podała prowizji, ostrożnie zakładamy prowizję w monecie (nie sprzedamy cudzej końcówki).
function lotFromOrder(o, base, quote, crossed) {
  let qty = o.filledQty, cost = o.filledAmount;
  if (o.fee > 0 && o.feeCur === base) qty -= o.fee;
  else if (o.fee > 0 && o.feeCur === quote) cost += o.fee;
  else if (crossed && !(o.fee > 0)) qty *= 0.999;
  if (!(qty > 0) || !(cost > 0)) return null;
  return {qty, cost, buyPx: cost / qty};
}

async function stepCoin(ctx, coin, removed) {
  const {ex, cfg, st, now, notify, quote} = ctx;
  const sym = coin.sym, pair = `${sym}-${quote}`, cs = coinState(st, sym);     // quote jest stała, dopóki są transze (patrz runBot)
  const sleep = ctx.sleep || (ms => new Promise(z => setTimeout(z, ms)));
  const info = await ex.pairInfo(pair);
  if (!info) { cs.note = `Para ${pair} jest niedostępna na giełdzie.`; return {}; }
  const t = await ex.ticker(pair);
  if (!(t && t.bid > 0 && t.ask > 0) || t.ask / t.bid > 1.03) { cs.note = 'Brak wiarygodnej ceny (zbyt duży rozrzut) – pominięto ten przebieg.'; return {}; }
  cs.px = (t.bid + t.ask) / 2; cs.pxAt = now; cs.note = '';
  const N = Math.max(1, Math.min(12, (coin.steps || []).length + 1));
  // próg sprzedaży: stały albo zależny od zmienności (średni dzienny zakres ceny z 14 dni × mnożnik, w granicach 2–12%)
  const tp = cfg.tpMode === 'atr' && cs.atr > 0 ? Math.max(0.02, Math.min(0.12, (+cfg.atrK || 2) * cs.atr)) : Math.max(0.5, Math.min(50, +coin.tp || 5)) / 100;
  cs.tpNow = tp;
  const dustBase = Math.max(info.baseStep, info.minBase);

  const place = async (o) => {             // zapisuje client_order_id PRZED wysłaniem (odzyskanie po awarii)
    if ((st.day?.d === ymd(now) ? st.day.n : 0) >= MAX_ORDERS_DAY) { st.halt = st.halt || `Bezpiecznik: ponad ${MAX_ORDERS_DAY} zleceń w ciągu dnia – automat wstrzymał nowe zlecenia.`; throw new Halt(st.halt); }
    st.day = st.day?.d === ymd(now) ? st.day : {d: ymd(now), n: 0}; st.day.n++;
    o.cid = o.cid || uid();
    if (o.onCid) o.onCid(o.cid);
    await ctx.save();
    const r = await ex.place({cid: o.cid, pair, side: o.side, price: o.price, base: o.base, postOnly: !!o.postOnly});
    return r.oid;
  };
  const recover = async (cid) => { const o = cid ? await ex.findByCid(pair, cid) : null; return o ? o.oid : null; };
  // zlecenie zastąpione ręcznie w Revolut X: automat nie wie, co z nim dalej – wstrzymanie, chyba że właściciel potwierdził (Wznów)
  const checkReplaced = (o) => {
    if (o.status !== 'replaced') return o;
    if (ctx.acceptReplaced) return {...o, status: 'cancelled', abandoned: true};   // właściciel przejął zlecenie – nie wystawiamy go ponownie
    st.halt = `Zlecenie automatu (${sym}) zostało zmienione ręcznie w Revolut X. Anuluj je tam albo zostaw jako swoje i stuknij „Wznów” – automat przestanie je śledzić.`;
    throw new Halt(st.halt);
  };
  const isOpen = async (o) => {
    if (o.status === 'new' || o.status === 'pending_new') return true;
    if (o.status === 'partially_filled') return (await ex.activeIds(pair)).has(o.oid);   // po anulowaniu stan „partially_filled” bywa końcowy
    return false;
  };
  // Revolut X nie zwraca po ID zleceń odrzuconych (np. post-only, które przecięłoby rynek) – szukamy wtedy po client_order_id w historii;
  // null = giełda nie zna zlecenia (decyzję, co dalej, podejmuje wywołujący)
  const getOrder = async (oid, cid) => {
    try { return checkReplaced(await ex.getOrder(oid)); }
    catch (e) {
      if (e.status !== 404) throw e;
      const o = cid ? await ex.findByCid(pair, cid) : null;
      return o ? checkReplaced(o) : null;
    }
  };
  // anuluj i poczekaj na potwierdzenie; bez potwierdzenia przerywamy (nic nie zastępujemy – ponowimy w następnym przebiegu)
  const cancelConfirm = async (oid, cid) => {
    await ex.cancel(oid);
    for (let i = 0; i < 6; i++) {
      const o = await getOrder(oid, cid);
      if (!o) return {oid, status: 'cancelled', filledQty: 0, filledAmount: 0, fee: 0, feeCur: null};
      if (!(await isOpen(o))) return o;
      await sleep(1000);
    }
    throw new Error('Giełda nie potwierdziła anulowania zlecenia – spróbuję w następnym przebiegu.');
  };
  const addLot = (p, o) => {
    const lot = o.filledQty > 0 ? lotFromOrder(o, sym, quote, p.cross) : null;
    if (!lot) return;
    const into = p.merge && cs.lots.find(l => l.id === p.merge && !l.exit);
    cs.lots.push({id: p.cid, buyOid: p.oid, pair, at: now, ...lot, ...(into ? {mergeInto: into.id} : {})});
    if (into) {
      ctx.events.push({t: now, sym, side: 'buy', px: lot.buyPx, qty: lot.qty, quote: lot.cost, n: cs.lots.indexOf(into) + 1, of: N, merge: true});
      notify(`Automat dokupił ${sym} do transzy`, `Cena ${fmt(lot.buyPx)} ${quote} · ${fmt(lot.cost, 2)} ${quote}. Reszta kapitału dołączona do istniejącej transzy – sprzedaż przeliczona.`);
      return;
    }
    ctx.events.push({t: now, sym, side: 'buy', px: lot.buyPx, qty: lot.qty, quote: lot.cost, n: cs.lots.length, of: N});
    notify(`Automat kupił ${sym} (transza ${cs.lots.length}/${N})`, `Cena ${fmt(lot.buyPx)} ${quote} · ${fmt(lot.cost, 2)} ${quote}. Sprzedaż przy +${(tp * 100).toFixed(1).replace('.', ',')}%.`);
    if (cs.lots.length === N) notify(`Automat: wszystkie transze ${sym} kupione`, 'Nowe dokupy wrócą, gdy któraś transza sprzeda się z zyskiem.');
  };
  // transza zamknięta bez sprzedaży (pył albo przejęta ręcznie): koszt reszty schodzi z puli, żeby budżet się nie „rozrastał”
  const dropLot = (lot, why = 'dust') => { if (why === 'dust') cs.dust += Math.max(0, lot.qty); else cs.handedOver = (cs.handedOver || 0) + lot.qty; cs.realized -= lot.cost; cs.lots = cs.lots.filter(x => x !== lot); };
  // rozliczenie (częściowo) wykonanej sprzedaży; zwraca true, gdy transza się skończyła (reszta poniżej minimalnej ilości = pył)
  const settleSell = (lot, o) => {
    if (!(o.filledQty > 0)) return false;
    const soldQty = Math.min(lot.qty, o.filledQty);
    let proceeds = o.filledAmount; if (o.fee > 0 && o.feeCur === quote) proceeds -= o.fee;
    const costPart = lot.cost * soldQty / lot.qty, pnl = proceeds - costPart;
    // sejf: część zysku nie wraca do obrotu (zostaje jako wolne środki, automat jej nie używa)
    const toVault = pnl > 0 && !lot.exit ? pnl * Math.max(0, Math.min(90, +cfg.vaultPct || 0)) / 100 : 0;
    cs.vault = (cs.vault || 0) + toVault;
    if (cfg.autoBudget && toVault) ctx.capital = Math.max(0, ctx.capital - toVault);   // kapitał policzony na starcie przebiegu zawierał już całą kwotę ze sprzedaży
    cs.realized += pnl - toVault; if (pnl > 0 && !lot.exit) { cs.cycles++; st.cycles = (st.cycles || 0) + 1; }
    ctx.events.push({t: now, sym, side: 'sell', px: o.filledAmount / o.filledQty, qty: soldQty, quote: proceeds, pnl, vault: toVault || undefined, reason: lot.exit ? 'exit' : 'tp'});
    notify(pnl >= 0 ? `Automat sprzedał ${sym} z zyskiem` : `Automat sprzedał ${sym}`, `${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl), 2)} ${quote} (${fmt(pnl / costPart * 100, 1)}%).${lot.exit ? '' : ' Zysk wraca do puli i kupuje dalej.'}`);
    lot.cost -= costPart; lot.qty -= soldQty;
    if (lot.qty < dustBase * 1.0001 || lot.qty * t.bid < info.minQuote) { dropLot(lot); return true; }
    return false;
  };

  const exitHit = coin.exit > 0 && t.bid >= coin.exit;
  const liq = (exitHit && !cs.exited) || (ctx.liquidate && (ctx.liquidate === '*' || ctx.liquidate === sym));

  // 1) oczekujące zlecenie kupna
  if (cs.pend) {
    const p = cs.pend;
    if (!p.oid) p.oid = await recover(p.cid);
    // nie znaleziono: świeże zlecenie mogło jeszcze nie trafić na listy giełdy – czekamy 10 min, zanim uznamy, że go nie ma
    if (!p.oid && now - p.at < 10 * 60000) { cs.why = 'czekam na potwierdzenie zlecenia przez giełdę'; return {}; }
    if (!p.oid) { if (p.maker) cs.makerMiss = (cs.makerMiss || 0) + 1; cs.pend = null; }   // zlecenie nigdy nie dotarło na giełdę (np. odrzucone post-only)
    else {
      let o = await getOrder(p.oid, p.cid);
      if (!o) {                            // giełda nie zna zlecenia (odrzucone) – po 2 min uznajemy, że nic się nie kupiło
        if (now - p.at < 2 * 60000) { cs.why = 'czekam na potwierdzenie zlecenia przez giełdę'; return {}; }
        o = {oid: p.oid, status: 'rejected', filledQty: 0, filledAmount: 0, fee: 0, feeCur: null};
      }
      let open = o.status === 'rejected' ? false : await isOpen(o);
      if (!open && o.status === 'partially_filled' && !o.abandoned) { o = await cancelConfirm(p.oid, p.cid); }
      // pierwsza transza ma się wykonać od razu; jeśli po 5 min wisi (cena uciekła) – anuluj i policz to, co się wykonało
      const stale = p.kind === 'first' && open && now - p.at > 5 * 60000;
      if (open && (stale || liq || removed)) { o = await cancelConfirm(p.oid, p.cid); open = false; }
      if (!open) {
        cs.makerMiss = p.maker && !(o.filledQty > 0) ? (cs.makerMiss || 0) + 1 : 0;   // zlecenie bez prowizji nie weszło – po 2 próbach kupimy po rynku
        addLot(p, o); cs.pend = null;      // przejęte ręcznie: liczymy tylko to, co się wykonało
      }
    }
  }

  const placeTp = async (lot) => {
    const qty = floorTo(lot.qty, info.baseStep), price = ceilTo(lot.buyPx * (1 + tp), info.quoteStep);
    if (+price < lot.buyPx) throw new Error('Błąd bezpieczeństwa: cena sprzedaży poniżej zakupu');
    if (+qty < info.minBase || +qty * +price < info.minQuote) { dropLot(lot); return; }
    lot.sellPx = +price; lot.sellAt = now;
    lot.sellOid = await place({side: 'sell', price, base: qty, onCid: c => { lot.sellCid = c; }});
  };

  // scalenie dokupionej reszty z transzą docelową (jedna transza = jedna sprzedaż)
  async function doMerges() {
    // transz więcej niż w planie (z wcześniejszych wersji): najmniejszą łączymy z kolejną najmniejszą
    if (!liq && cfg.buyMode !== 'dip') {
      const act = cs.lots.filter(l => !l.exit && !l.mergeInto);
      if (act.length > N && !cs.lots.some(l => l.mergeInto)) { const [a, b] = [...act].sort((x, y) => x.cost - y.cost); a.mergeInto = b.id; }
    }
    for (const m of [...cs.lots]) {
      if (!m.mergeInto) continue;
      const tg = cs.lots.find(l => l.id === m.mergeInto && l !== m);
      if (!tg || tg.exit || m.exit || liq) { delete m.mergeInto; continue; }          // brak celu / wyjście – zostaje osobną transzą
      // sprzedaż dołączanej transzy (gdy już miała własną) – zdejmujemy najpierw
      if (m.sellCid && !m.sellOid) { m.sellOid = await recover(m.sellCid); if (!m.sellOid) { if (now - (m.sellAt || 0) < 10 * 60000) continue; m.sellCid = null; } }
      if (m.sellOid) {
        const o = await cancelConfirm(m.sellOid, m.sellCid);
        if (settleSell(m, o)) { delete tg.mergeInto; continue; }
        m.sellOid = null; m.sellCid = null;
      }
      if (tg.sellCid && !tg.sellOid) { tg.sellOid = await recover(tg.sellCid); if (!tg.sellOid) { if (now - (tg.sellAt || 0) < 10 * 60000) continue; tg.sellCid = null; } }
      if (tg.sellOid) {
        const o = await cancelConfirm(tg.sellOid, tg.sellCid);
        if (settleSell(tg, o)) { delete m.mergeInto; continue; }                       // cel zdążył się sprzedać – dokupiona reszta zostaje osobną transzą
        tg.sellOid = null; tg.sellCid = null;
      }
      tg.qty += m.qty; tg.cost += m.cost; tg.buyPx = tg.cost / tg.qty;
      cs.lots = cs.lots.filter(x => x !== m);
      await placeTp(tg);
    }
  }
  await doMerges();

  // 2) transze: zlecenia sprzedaży
  for (const lot of [...cs.lots]) {
    if (lot.mergeInto) continue;           // czeka na scalenie
    if (!lot.sellOid && lot.sellCid) {
      lot.sellOid = await recover(lot.sellCid);
      if (!lot.sellOid && now - (lot.sellAt || 0) < 10 * 60000) continue;    // jak wyżej: poczekaj, zanim wystawisz ponownie
      if (!lot.sellOid) lot.sellCid = null;
    }
    if (lot.sellOid) {
      let o = await getOrder(lot.sellOid, lot.sellCid);
      if (!o) { lot.sellOid = null; lot.sellCid = null; lot.sellAt = now; continue; }   // sprzedaż odrzucona – wystawimy ponownie za 10 min
      if (await isOpen(o)) {
        const reprice = lot.exit && lot.sellPx > t.bid * 1.01;     // sprzedaż wyjścia, a rynek spadł – przestaw niżej
        if (!(liq && !lot.exit) && !reprice) continue;             // czeka na giełdzie
        o = await cancelConfirm(lot.sellOid, lot.sellCid);         // przy wyjściu: zdejmij sprzedaż +tp i wystaw sprzedaż po rynku
      } else if (o.status === 'partially_filled' && !o.abandoned) o = await cancelConfirm(lot.sellOid, lot.sellCid);
      if (settleSell(lot, o)) continue;
      if (o.abandoned) { dropLot(lot, 'handover'); continue; }    // reszta należy już do właściciela – nie sprzedajemy jej
      lot.sellOid = null; lot.sellCid = null;
    }
    if (liq) lot.exit = true;
    const exitPx = floorTo(t.bid * 0.995, info.quoteStep);
    const qty = floorTo(lot.qty, info.baseStep), price = lot.exit ? exitPx : ceilTo(lot.buyPx * (1 + tp), info.quoteStep);
    if (!lot.exit && +price < lot.buyPx) throw new Error('Błąd bezpieczeństwa: cena sprzedaży poniżej zakupu');
    if (+qty < info.minBase || +qty * +price < info.minQuote) { dropLot(lot); continue; }     // pył – zostaje na koncie, transza zamknięta
    lot.sellPx = +price; lot.sellAt = now;
    lot.sellOid = await place({side: 'sell', price, base: qty, onCid: c => { lot.sellCid = c; }});
  }

  // 3) wyjście: cena wyjścia albo „Sprzedaj wszystko”
  if (liq || cs.exited) {
    if (liq && !cs.exited) {
      cs.exited = true;
      if (exitHit) notify(`Automat: ${sym} doszedł do ceny wyjścia`, `Cena ${fmt(t.bid)} ${quote} ≥ ${fmt(coin.exit)} – sprzedaję wszystkie transze i kończę zakupy tej monety.`);
    }
    cs.why = 'zakończone (cena wyjścia albo „Sprzedaj wszystko”) – wznów w ustawieniach';
    return {liqDone: !cs.pend && cs.lots.every(l => l.exit && l.sellOid)};
  }
  if (removed) { cs.why = 'moneta usunięta z ustawień – czekają tylko sprzedaże'; return {}; }

  // 4) nowe zakupy
  const trendOk = !cfg.trend || cs.trendUp !== false;
  const capOk = !(coin.cap > 0) || t.ask <= coin.cap;
  const allowed = ctx.active && trendOk && capOk && !st.halt && +coin.share > 0;
  cs.why = !ctx.active ? 'wstrzymany' : st.halt ? 'bezpiecznik' : !(+coin.share > 0) ? 'udział 0%' : !trendOk ? 'cena pod średnią 200 dni' : !capOk ? 'cena powyżej limitu' : '';
  const cancelPend = async () => { const p = cs.pend; if (!p) return; const o = p.oid ? await cancelConfirm(p.oid, p.cid) : null; if (o) addLot(p, o); cs.pend = null; };
  if (!allowed) { if (cs.pend) await cancelPend(); return {}; }

  // tryb „od razu”: wolny kapitał monety od razu w transze (każda transza żyje niezależnie: kupno → sprzedaż +tp → kupno)
  if (cfg.buyMode !== 'dip') {
    if (cs.pend && cs.pend.kind === 'dip') await cancelPend();     // dokup z trybu „przy spadkach” – anulowanie potwierdzone, można kupować
    if (cs.pend) return {};                // poprzednie kupno jeszcze się wykonuje
    const pool = ctx.pool(coin, cs), minQ = Math.max(MIN_QUOTE, info.minQuote);
    for (let k = 0; k < N + 2; k++) {
      const free = pool - cs.lots.reduce((a, l) => a + l.cost, 0);
      // nigdy więcej transz niż w planie: reszta (np. po częściowo wykonanym zakupie) dokupuje się do najmniejszej transzy
      const full = cs.lots.length >= N, into = full ? cs.lots.filter(l => !l.exit && !l.mergeInto).sort((a, b) => a.cost - b.cost)[0] : null;
      if (full && (!into || cs.lots.some(l => l.mergeInto))) break;
      let amt = full ? Math.min(free, ctx.globalRoom()) : Math.min(pool / N, free, ctx.globalRoom());
      if (Math.min(free, ctx.globalRoom()) - amt < minQ) amt = Math.min(free, ctx.globalRoom());   // resztka dołącza do tej transzy
      if (!(amt >= minQ)) { if (!cs.lots.length) cs.why = ctx.globalRoom() < minQ ? 'cały kapitał automatu jest zaangażowany' : 'za mało kapitału na transzę (min. 10)'; break; }
      const avail = await ex.available(quote) - vaultNow(st);   // sejf nigdy nie idzie na zakupy
      if (avail < amt * 1.002 && avail >= minQ * 1.002) amt = avail / 1.002;
      if (!(avail >= amt * 1.002)) { cs.why = `za mało ${quote} na giełdzie`; break; }
      // bez prowizji: zlecenie oczekujące po najlepszej ofercie kupna (post_only); po 2 nieudanych próbach – po rynku
      const maker = cfg.makerBuy !== false && (cs.makerMiss || 0) < 2;
      const price = maker ? floorTo(t.bid, info.quoteStep) : ceilTo(t.ask * 1.003, info.quoteStep), base = floorTo(amt / +price, info.baseStep);
      if (+base < info.minBase || +base * +price < info.minQuote) { cs.why = 'transza poniżej minimalnej wielkości zlecenia'; break; }
      const pend = {kind: 'first', px: +price, base: +base, quote: +base * +price, at: now, cross: !maker, maker, pair, cid: null, oid: null, merge: into ? into.id : undefined};
      cs.pend = pend;
      pend.oid = await place({side: 'buy', price, base, postOnly: maker, onCid: c => { pend.cid = c; }});
      // zlecenie przecina rynek – zwykle wykonuje się od razu; sprawdzamy i od razu wystawiamy sprzedaż
      for (let i = 0; i < 3 && cs.pend; i++) {
        const o = await getOrder(pend.oid, pend.cid);
        if (!o) break;                     // giełda jeszcze nie zna zlecenia albo je odrzuciła – rozstrzygnie następny przebieg
        if (!(await isOpen(o))) { cs.makerMiss = maker && !(o.filledQty > 0) ? (cs.makerMiss || 0) + 1 : 0; addLot(pend, o); cs.pend = null; } else await sleep(maker ? 300 : 1000);
      }
      if (cs.pend) break;                  // dokończymy w następnym przebiegu
      await doMerges();
      for (const lot of cs.lots) if (!lot.sellOid && !lot.sellCid && !lot.exit && !lot.mergeInto) await placeTp(lot);
    }
    return {};
  }

  let want = null;                         // {kind, px}
  if (!cs.lots.length) want = {kind: 'first', px: t.ask};
  else if (cs.lots.length < N) {
    const minBuy = Math.min(...cs.lots.map(l => l.buyPx));
    const step = (coin.steps[cs.lots.length - 1] || coin.steps[coin.steps.length - 1] || 5) / 100;
    want = {kind: 'dip', px: minBuy * (1 - step)};
  }
  // istniejące zlecenie kupna nie pasuje już do planu → anuluj (np. sprzedała się najniższa transza albo zmieniły się ustawienia)
  if (cs.pend && (!want || cs.pend.kind !== want.kind || (want.kind === 'dip' && Math.abs(cs.pend.px / want.px - 1) > 0.003))) {
    await cancelPend();
    return {};                             // nowe zlecenie w następnym przebiegu
  }
  if (cs.pend || !want) return {};
  const slots = N - cs.lots.length;
  const pool = ctx.pool(coin, cs);
  const freeQ = pool - cs.lots.reduce((a, l) => a + l.cost, 0);
  let amt = Math.min(freeQ / slots, freeQ, ctx.globalRoom());          // limit całkowity: budżet + zysk – wszystko, co już zaangażowane
  if (!(amt >= Math.max(MIN_QUOTE, info.minQuote))) { cs.why = ctx.globalRoom() < freeQ / slots ? 'cały budżet automatu jest już zaangażowany' : 'za mało środków w puli na kolejną transzę'; return {}; }
  const avail = await ex.available(quote) - vaultNow(st);   // sejf nigdy nie idzie na zakupy
  // drobna różnica (prowizje) – kupujemy za tyle, ile jest; większy brak = ktoś wypłacił środki albo budżet jest za wysoki
  if (avail < amt * 1.002 && avail >= amt * 0.9) amt = avail / 1.002;
  if (!(avail >= amt * 1.002) || amt < Math.max(MIN_QUOTE, info.minQuote)) { cs.why = `za mało ${quote} na giełdzie`; return {}; }
  const cross = want.kind === 'first' || want.px >= t.ask;
  const price = cross ? ceilTo(t.ask * 1.003, info.quoteStep) : floorTo(want.px, info.quoteStep);
  const base = floorTo(amt / +price, info.baseStep);
  if (+base < info.minBase || +base * +price < info.minQuote) { cs.why = 'transza poniżej minimalnej wielkości zlecenia'; return {}; }
  const pend = {kind: want.kind, px: +price, base: +base, quote: +base * +price, at: now, cross, pair, cid: null, oid: null};
  cs.pend = pend;
  pend.oid = await place({side: 'buy', price, base, postOnly: !cross, onCid: c => { pend.cid = c; }});
  return {};
}

// trend: dzienne zamknięcie (wczorajsze) powyżej średniej 200 dni
const vaultNow = st => Object.values(st.coins || {}).reduce((a, c) => a + (c.vault || 0), 0);
function trendUp(closes) {
  if (!closes || closes.length < 201) return null;
  const c = closes.slice(0, -1), last = c[c.length - 1], sma = c.slice(-200).reduce((a, b) => a + b, 0) / 200;
  return {up: last > sma, sma, last};
}

// job: 'paper' | 'live' – który stan obsługujemy; polecenia z aplikacji dotyczą tylko trybu, w którym je wydano
async function runBot({ex, cfg, st, job, now = Date.now(), notify = () => {}, save = async () => {}, trend = {}, sleep, maxBudget = 0}) {
  job = job || cfg.mode;
  st.createdAt = st.createdAt || now;
  // waluty nie zmieniamy, dopóki są transze lub zlecenia (inaczej zlecenia na starej parze zostałyby wystawione drugi raz)
  const busy = Object.values(st.coins || {}).some(c => c.lots?.length || c.pend);
  const heldQuote = st.quote || Object.values(st.coins || {}).flatMap(c => [c.pend?.pair, ...(c.lots || []).map(l => l.pair)]).filter(Boolean).map(p => p.split('-')[1])[0];
  const quote = busy && heldQuote ? heldQuote : (cfg.quote || 'USD');
  st.quote = quote;
  st.quoteNote = busy && cfg.quote && cfg.quote !== quote ? `Zmiana waluty na ${cfg.quote} zadziała, gdy automat sprzeda wszystkie transze (teraz ${quote}).` : '';
  const ctx = {ex, cfg, st, now, notify, save, sleep, quote, events: [],
    active: (cfg.mode === 'live' || cfg.mode === 'paper') && cfg.mode === job ? !cfg.paused : false, liquidate: null, acceptReplaced: false};
  const cmd = cfg.cmd;
  const cmdValid = cmd?.id && st.cmdDone !== cmd.id && cmd.mode === job && (cmd.at || 0) >= (st.createdAt || 0) - 60000;
  if (cmdValid) {
    if (cmd.type === 'liquidate') ctx.liquidate = cmd.sym || '*';
    if (cmd.type === 'resetHalt') { st.halt = null; ctx.acceptReplaced = true; st.cmdDone = cmd.id; }
    if (cmd.type === 'vaultReset') { Object.values(st.coins || {}).forEach(c => { c.vault = 0; }); st.cmdDone = cmd.id; }
    if (cmd.type === 'resetExit') { Object.values(st.coins || {}).forEach(c => { c.exited = false; }); st.cmdDone = cmd.id; }
  }
  const committed = () => Object.values(st.coins || {}).reduce((a, c) => a + c.lots.reduce((x, l) => x + l.cost, 0) + (c.pend ? c.pend.quote : 0), 0);
  const maxB = maxBudget > 0 ? maxBudget : Infinity;
  if (cfg.autoBudget) {
    // kapitał = to, co już pracuje + wolne środki na giełdzie (każda wpłata od razu do pracy), najwyżej do limitu z ustawień i BOT_MAX_BUDGET
    let avail = 0; try { avail = Math.max(0, await ex.available(ctx.quote)); } catch (e) {}
    const vaultAll = Object.values(st.coins || {}).reduce((a, c) => a + (c.vault || 0), 0);
    // sprzedaże wykonane od ostatniego przebiegu: pieniądze są już w wolnych środkach, a transza jeszcze nierozliczona – nie liczymy jej dwa razy
    let settledAway = 0; const act = {};
    for (const c of Object.values(st.coins || {})) for (const l of c.lots || []) {
      if (!l.pair || !(l.sellOid || l.sellCid)) continue;
      if (!l.sellOid) { settledAway += l.cost; continue; }                        // sprzedaż wysłana bez potwierdzenia – ostrożnie jak rozliczona
      if (!(l.pair in act)) { try { act[l.pair] = await ex.activeIds(l.pair); } catch (e) { act[l.pair] = null; } }
      if (!act[l.pair] || !act[l.pair].has(l.sellOid)) settledAway += l.cost;     // brak danych = ostrożnie (mniejszy kapitał)
    }
    ctx.capital = Math.max(0, Math.min(committed() - settledAway + Math.max(0, avail - vaultAll), +cfg.budget > 0 ? +cfg.budget : Infinity, maxB));
    ctx.pool = (coin) => ctx.capital * (+coin.share || 0) / 100;
  } else {
    const realizedAll = () => Object.values(st.coins || {}).reduce((a, c) => a + (c.realized || 0), 0);
    ctx.capFn = () => Math.min(+cfg.budget || 0, maxB) + realizedAll();     // zysk ze sprzedaży w tym przebiegu od razu w obrocie
    ctx.capital = ctx.capFn();
    ctx.pool = (coin, cs) => Math.min(+cfg.budget || 0, maxB) * (+coin.share || 0) / 100 + (cs.realized || 0);
  }
  st.capital = ctx.capital;
  ctx.globalRoom = () => (ctx.capFn ? (ctx.capital = ctx.capFn()) : ctx.capital) - committed();
  const errors = [];
  const valid = c => /^[A-Z0-9]{2,10}$/.test(c.sym);
  const list = (cfg.coins || []).filter(valid).map(c => ({coin: c, removed: false}));
  // monety usunięte z ustawień, ale z transzami lub zleceniem kupna: dalej rozliczamy (bez nowych zakupów)
  for (const [sym, cs] of Object.entries(st.coins || {})) {
    if (list.some(x => x.coin.sym === sym) || !(cs.lots?.length || cs.pend)) continue;
    list.push({coin: {sym, share: 0, tp: cs.conf?.tp || 5, steps: cs.conf?.steps || [5]}, removed: true});
  }
  let liqAll = true, halted = false;
  for (const {coin, removed} of list) {
    const cs = coinState(st, coin.sym);
    if (!removed) cs.conf = {tp: coin.tp, steps: coin.steps};
    cs.trendUp = trend[coin.sym] ? trend[coin.sym].up : null; cs.sma = trend[coin.sym]?.sma || null;   // brak danych = bez blokady
    cs.atr = trend[coin.sym]?.atr > 0 ? trend[coin.sym].atr : null;
    try {
      const r = await stepCoin(ctx, coin, removed);
      if (ctx.liquidate && (ctx.liquidate === '*' || ctx.liquidate === coin.sym) && (cs.lots.length || cs.pend) && !r.liqDone) liqAll = false;
      cs.err = '';
    } catch (e) {
      liqAll = false;
      if (e instanceof Halt) { if (!halted) notify('Automat wstrzymany', st.halt); halted = true; continue; }   // inne monety: dalej rozliczamy, zakupy stoją (st.halt)
      errors.push(`${coin.sym}: ${e.message}`); cs.err = e.message;
    }
  }
  // polecenie „Sprzedaj wszystko” uznajemy za wykonane dopiero, gdy każda transza ma wystawioną sprzedaż wyjścia
  if (cmdValid && cmd.type === 'liquidate' && liqAll && !halted) st.cmdDone = cmd.id;
  if (ctx.capFn) ctx.capital = ctx.capFn();
  st.capital = ctx.capital;
  st.history = [...(st.history || []), ...ctx.events].slice(-800);
  let value = 0, cost = 0, realized = 0, pendQ = 0, vault = 0;
  for (const c of Object.values(st.coins || {})) {
    realized += c.realized || 0; pendQ += c.pend ? c.pend.quote : 0; vault += c.vault || 0;
    for (const l of c.lots) { value += l.qty * (c.px || l.buyPx); cost += l.cost; }
  }
  st.totals = {realized: realized + vault, reinvested: realized, vault, invested: cost, value, pending: pendQ, cash: Math.max(0, ctx.capital - cost - pendQ), capital: ctx.capital, cycles: st.cycles || 0};
  const botValue = st.totals.cash + pendQ + value + vault;
  // porównanie z trzymaniem: te same wpłaty kupione według suwaków w chwili wpłaty i trzymane bez sprzedaży
  const base = Math.max(0, ctx.capital - realized);                 // wpłacony kapitał (bez wypracowanego zysku)
  const px = sym => st.coins?.[sym]?.px || 0;
  const buyHodl = (h, add) => {
    const coins = (cfg.coins || []).filter(c => +c.share > 0 && px(c.sym) > 0);
    let used = 0;
    for (const c of coins) { const a = add * +c.share / 100; h.units[c.sym] = (h.units[c.sym] || 0) + a / px(c.sym); used += a; }
    h.cash += add - used;
  };
  // start porównania (także dla automatu, który już pracował): „trzymanie” startuje z bieżącą wartością automatu
  if (!st.hodl) { st.hodl = {base, units: {}, cash: 0, at: now}; if (botValue > 0) buyHodl(st.hodl, botValue); }
  const h = st.hodl;
  if (base - h.base >= 1) { buyHodl(h, base - h.base); h.base = base; }
  else if (h.base - base >= 1 && h.base > 0) {                    // wypłata: pomniejsz proporcjonalnie
    const k = base / h.base; Object.keys(h.units).forEach(s => { h.units[s] *= k; }); h.cash *= k; h.base = base;
  }
  const hodlValue = h.cash + Object.entries(h.units).reduce((a, [s, u]) => a + u * (px(s) || 0), 0);
  st.totals.value_all = botValue; st.totals.hodl = hodlValue;
  const d = ymd(now); st.equity = (st.equity || []).filter(x => x.d !== d); st.equity.push({d, v: +botValue.toFixed(2), h: +hodlValue.toFixed(2)}); st.equity = st.equity.slice(-400);
  st.lastRun = now; st.mode = cfg.mode;
  return {errors, events: ctx.events};
}

module.exports = {runBot, trendUp, floorTo, ceilTo, decimals, lotFromOrder, MAX_ORDERS_DAY};
