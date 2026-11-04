// Cloudflare Worker: co 5 minut uruchamia przebieg automatu w GitHub Actions (workflow_dispatch).
// Harmonogram GitHuba bywa opóźniony o 10–30 min; to wywołanie jest punktualne.
//
// Ustawienie (raz):
// 1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:
//    repozytorium tylko Kowals96/crypto-control, uprawnienie „Actions: Read and write” (nic więcej), ważność np. 1 rok.
// 2. Cloudflare (darmowe konto) → Workers & Pages → Create → „Hello World” Worker → Edit code → wklej ten plik → Deploy.
// 3. Worker → Settings → Variables and Secrets → dodaj Secret: GH_TOKEN = token z punktu 1.
// 4. Worker → Settings → Trigger events (Cron Triggers) → Add → "*/5 * * * *".
// Token może tylko uruchamiać przebiegi tego repozytorium – nie ma dostępu do sekretów ani pieniędzy.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  async fetch() {
    return new Response('Automat transz – wyzwalacz działa (wywołania co 5 min z harmonogramu Cloudflare).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  },
};

async function dispatch(env) {
  const r = await fetch('https://api.github.com/repos/Kowals96/crypto-control/actions/workflows/bot.yml/dispatches', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.GH_TOKEN,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'crypto-control-bot-trigger',
    },
    body: JSON.stringify({ref: 'main'}),
  });
  if (r.status !== 204) console.log('GitHub odpowiedział', r.status);
}
