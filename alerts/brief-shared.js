// Generowane z index.html (blok BRIEF-SHARED) – nie edytuj ręcznie.
var BRIEF = (function () {
  var p2 = function (n) { return String(n).padStart(2, '0'); };
  function ymd(s) { return s.split('-').map(Number); }
  function dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function fromParts(y, m, d) {
    var yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12 + 12) % 12 + 1;
    return yy + '-' + p2(mm) + '-' + p2(Math.min(d, dim(yy, mm)));
  }
  function addDays(s, n) { var a = ymd(s); return new Date(Date.UTC(a[0], a[1] - 1, a[2] + n)).toISOString().slice(0, 10); }
  function diffDays(a, b) { var A = ymd(a), B = ymd(b); return Math.round((Date.UTC(B[0], B[1] - 1, B[2]) - Date.UTC(A[0], A[1] - 1, A[2])) / 864e5); }
  var STEP = {m: 1, q: 3, h: 6, y: 12, '2y': 24};
  // najbliższe wystąpienie terminu (anchor = pierwsza data, e = okres) w dniu "from" lub później
  function next(anchor, e, from) {
    if (!anchor || !/^\d{4}-\d\d-\d\d$/.test(anchor)) return null;
    if (from <= anchor) return anchor;
    if (!e) return null;
    if (e === 'w') return addDays(anchor, Math.ceil(diffDays(anchor, from) / 7) * 7);
    var k = STEP[e]; if (!k) return null;
    var a = ymd(anchor), f = ymd(from);
    var i = Math.max(0, Math.floor(((f[0] * 12 + f[1]) - (a[0] * 12 + a[1])) / k));
    for (var j = 0; j < 3; j++) { var c = fromParts(a[0], a[1] + (i + j) * k, a[2]); if (c >= from) return c; }
    return null;
  }
  function occurs(anchor, e, d) { return next(anchor, e, d) === d; }
  // przypomnienia na dziś: items = [{t: nazwa, k: 'pay'|'date', d: data, e: okres, pre: [dni przed]}]
  function due(items, today) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      (it.pre || []).slice().sort(function (a, b) { return a - b; }).forEach(function (n) {
        var key = it.k + '|' + it.t + '|' + it.d;
        if (seen[key]) return;
        if (occurs(it.d, it.e, addDays(today, n))) { seen[key] = 1; out.push({t: it.t, k: it.k, n: n}); }
      });
    });
    return out.sort(function (a, b) { return a.n - b.n; });
  }
  var when = function (n) { return n === 0 ? 'dziś' : n === 1 ? 'jutro' : 'za ' + n + ' dni'; };
  var pc = function (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + '%'; };
  var usd = function (v) { return '$' + (v >= 100 ? Math.round(v).toLocaleString('pl-PL') : v.toPrecision(4).replace('.', ',')); };
  var WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  // c = {today, brief:{on, rem, pf, fg, cal}, pf:{ch, btc:{p,ch}, best, worst}, fg:{v,l}, items, cal:[{d,t,h}]}
  function compose(c) {
    var a = ymd(c.today), b = c.brief || {}, L = [];
    var r = b.rem === false ? [] : due(c.items, c.today);
    var pays = r.filter(function (x) { return x.k === 'pay'; }), dates = r.filter(function (x) { return x.k === 'date'; });
    if (pays.length) L.push('💳 Płatności: ' + pays.map(function (x) { return x.t + ' (' + when(x.n) + ')'; }).join(', '));
    if (dates.length) L.push('📅 Terminy: ' + dates.map(function (x) { return x.t + ' (' + when(x.n) + ')'; }).join(', '));
    var remLines = L.slice();
    if (b.on) {
      var top = [];
      if (b.pf !== false && c.pf) {
        top.push('📈 Portfel 24 h: ' + pc(c.pf.ch) + (c.pf.btc ? ' · BTC ' + usd(c.pf.btc.p) + ' (' + pc(c.pf.btc.ch) + ')' : ''));
        if (c.pf.best && c.pf.worst && c.pf.best.s !== c.pf.worst.s) top.push('Najmocniej ' + c.pf.best.s + ' ' + pc(c.pf.best.ch) + ', najsłabiej ' + c.pf.worst.s + ' ' + pc(c.pf.worst.ch));
      }
      if (b.fg !== false && c.fg) top.push('🧭 Nastroje rynku: ' + c.fg.v + ' – ' + c.fg.l);
      if (b.cal !== false) {
        var tom = addDays(c.today, 1), ev = (c.cal || []).filter(function (e) { return e.d === c.today || e.d === tom; });
        if (ev.length) L.push('🗓 Rynek: ' + ev.map(function (e) { return (e.d === c.today ? 'dziś ' : 'jutro ') + e.t + (e.h ? ' ' + e.h : ''); }).join(', '));
      }
      L = top.concat(L);
    }
    return {
      title: b.on ? '☀️ Dzień dobry · ' + WD[new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay()] + ' ' + a[2] + '.' + p2(a[1]) : '🔔 Przypomnienie',
      body: (b.on ? L : remLines).join('\n') || 'Spokojny dzień – żadnych płatności ani terminów.',
      lines: b.on ? L : remLines, hasRem: remLines.length > 0
    };
  }
  var FG_PL = {'extreme fear': 'skrajny strach', 'fear': 'strach', 'neutral': 'neutralnie', 'greed': 'chciwość', 'extreme greed': 'skrajna chciwość'};
  // pf z udziałów monet: coins = [{s, w}], px = {SYM: {p, ch}}
  function portfolio(coins, px) {
    var sw = 0, sc = 0, list = [];
    (coins || []).forEach(function (c) { var q = px[c.s]; if (!q || !(q.p > 0) || !isFinite(q.ch)) return; sw += c.w; sc += c.w * q.ch; list.push({s: c.s, ch: q.ch}); });
    if (!sw) return null;
    list.sort(function (x, y) { return y.ch - x.ch; });
    return {ch: sc / sw, btc: px.BTC && px.BTC.p > 0 ? px.BTC : null, best: list[0], worst: list[list.length - 1]};
  }
  return {next: next, occurs: occurs, due: due, compose: compose, portfolio: portfolio, addDays: addDays, diffDays: diffDays, when: when, FG_PL: FG_PL};
})();
if (typeof module !== 'undefined') module.exports = BRIEF;
