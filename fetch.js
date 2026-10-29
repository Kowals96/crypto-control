// pobiera świece 1h z publicznego API danych Binance (bez klucza) i zapisuje jako CSV
const fs = require('fs'), zlib = require('zlib');
const syms = ['DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'XRPUSDT', 'ADAUSDT', 'BNBUSDT', 'DOTUSDT', 'NEARUSDT', 'SUIUSDT', 'PEPEUSDT'];
(async () => {
  for (const s of syms) {
    let t = Date.parse('2021-01-01T00:00:00Z'), rows = [];
    while (t < Date.now()) {
      let r, tries = 0;
      for (;;) {
        try { r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=1h&startTime=${t}&limit=1000`); if (r.ok) break; console.log(s, r.status); } catch (e) { console.log(e.message); }
        if (++tries > 5) throw new Error('fail ' + s); await new Promise(z => setTimeout(z, 2000));
      }
      const d = await r.json();
      if (!d.length) break;
      d.forEach(k => rows.push([Math.round(k[0] / 1000), +k[1], +k[2], +k[3], +k[4]].join(',')));
      t = d[d.length - 1][0] + 3600000;
    }
    fs.writeFileSync(`${s}.csv.gz`, zlib.gzipSync('ts,o,h,l,c\n' + rows.join('\n')));
    console.log(s, rows.length);
  }
})().catch(e => { console.error(e); process.exit(1); });
