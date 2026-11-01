const fs = require('fs');
(async () => {
  const out = {at: new Date().toISOString()};
  for (const s of ['BTC', 'ETH', 'SOL']) {
    const t = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${s}USDT`)).json();
    const k = await (await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${s}USDT&interval=1d&limit=400`)).json();
    const c = k.map(x => +x[4]), last = c[c.length - 1];
    const sma = n => c.slice(-n).reduce((a, b) => a + b, 0) / n;
    out[s] = {price: +t.lastPrice, ch24: +t.priceChangePercent, sma50: sma(50), sma200: sma(200), hi365: Math.max(...k.slice(-365).map(x => +x[2])), lo365: Math.min(...k.slice(-365).map(x => +x[3])),
      ch7: (last / c[c.length - 8] - 1) * 100, ch30: (last / c[c.length - 31] - 1) * 100, ch90: (last / c[c.length - 91] - 1) * 100};
  }
  try { out.fng = (await (await fetch('https://api.alternative.me/fng/?limit=7')).json()).data.map(x => [x.value, x.value_classification]); } catch (e) {}
  fs.writeFileSync('probe.json', JSON.stringify(out, null, 1));
})();
