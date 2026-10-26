// Проверка Gemma для сайта Secretbox — без раскрытия ключа.
// Cloudflare Worker: ключ хранится в его секретах (GEMMA_API_KEY), сайт получает только «работает / нет».
//
// GET /health → { "ok": true, "status": 200, "ms": 812, "model": "gemma4", "checked_at": "..." }

const GEMMA_URL = 'https://llm.alem.ai/v1/chat/completions';
const MODEL = 'gemma4';
const TIMEOUT_MS = 20000;
const CACHE_MS = 60000; // частые нажатия не тратят запросы к Gemma — результат держится минуту

// сайты, которым разрешено спрашивать (остальным браузер не отдаст ответ)
const ALLOWED_ORIGINS = [
  'https://the-fabulous.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

let last = null; // { at, body } — последний результат в этом экземпляре воркера

async function checkGemma(apiKey) {
  if (!apiKey) return { ok: false, status: 0, error: 'no_key' };
  const started = Date.now();
  try {
    const res = await fetch(GEMMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel(); // текст ответа Gemma наружу не отдаём
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : 'network', ms: Date.now() - started };
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' || pathname !== '/health') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    if (!last || Date.now() - last.at > CACHE_MS) {
      const body = { ...(await checkGemma(env.GEMMA_API_KEY)), model: MODEL, checked_at: new Date().toISOString() };
      last = { at: Date.now(), body };
    }
    return new Response(JSON.stringify(last.body), {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
