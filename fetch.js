// sonda: czy Revolut X odpowiada z serwerów GitHuba (publiczne dane, bez klucza)
const fs = require('fs');
(async () => {
  const out = {};
  for (const p of ['/api/1.0/public/order-book/BTC-USD', '/api/1.0/public/order-book/BTC-USDC', '/api/1.0/public/order-book/SOL-USD', '/api/1.0/public/order-book/ETH-EUR', '/api/1.0/public/last-trades', '/api/1.0/balances']) {
    try { const r = await fetch('https://revx.revolut.com' + p); const t = await r.text(); out[p] = {status: r.status, body: t.slice(0, 600)}; }
    catch (e) { out[p] = {error: String(e)}; }
  }
  try { const ip = await (await fetch('https://ipinfo.io/json')).json(); out.runner = {country: ip.country, region: ip.region}; } catch (e) {}
  fs.writeFileSync('probe.json', JSON.stringify(out, null, 1));
  console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.status || v.error || v.country])));
})();
