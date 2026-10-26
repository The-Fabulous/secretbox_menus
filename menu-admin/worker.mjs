import { inspectPackage, LIMITS } from '../coffee-menu/admin/validation.mjs';

const encoder = new TextEncoder();
const MAX_BODY = 29 * 1024 * 1024;
const SESSION_SECONDS = 8 * 60 * 60;
const WORKFLOW = 'parse-menu.yml';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const encode64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const decode64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function signingKey(password) {
  return crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function session(password) {
  const payload = btoa(JSON.stringify({ scope: 'menu-admin', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: crypto.randomUUID() }));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(password), encoder.encode(payload)));
  return `${payload}.${encode64(signature)}`;
}
async function authorized(request, password) {
  try {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const parts = token.split('.');
    if (parts.length !== 2 || token.length > 1024) return false;
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify('HMAC', await signingKey(password), decode64(signature), encoder.encode(payload))) return false;
    const data = JSON.parse(atob(payload));
    return data.scope === 'menu-admin' && Number.isFinite(data.exp) && data.exp > Date.now() / 1000;
  } catch { return false; }
}
async function samePassword(actual, expected) {
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(actual)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(expected)));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function bodyJSON(request, maximum) {
  if (Number(request.headers.get('Content-Length')) > maximum) fail(413, 'Запрос слишком большой.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Пустой запрос.');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); fail(413, 'Запрос слишком большой.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(400, 'Некорректный JSON.'); }
}

function github(env) {
  const root = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  return async (path, method = 'GET', body, optional = false) => {
    let response;
    try {
      response = await fetch(root + path, { method, headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Secretbox-Menu-Admin', 'Content-Type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    } catch { fail(502, 'GitHub не ответил. Повторите проверку или загрузку: одна и та же заявка не создаст дубль.'); }
    if (optional && response.status === 404) return null;
    if (!response.ok) {
      const code = response.status;
      await response.body?.cancel();
      if (code === 409 || code === 422) fail(409, 'Репозиторий изменился во время загрузки. Повторите ту же заявку.');
      fail(502, `GitHub вернул ошибку ${code}. Администратору нужно проверить доступ сервера и лимиты API.`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
}

function imageHeader(bytes, name) {
  const head = Array.from(bytes.slice(0, 12));
  const ascii = (a, b) => String.fromCharCode(...head.slice(a, b));
  if (/\.png$/i.test(name)) return head.slice(0, 8).join() === '137,80,78,71,13,10,26,10';
  if (/\.jpe?g$/i.test(name)) return head[0] === 255 && head[1] === 216 && head[2] === 255;
  if (/\.webp$/i.test(name)) return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  return /\.bmp$/i.test(name) && ascii(0, 2) === 'BM';
}

async function createUpload(data, env) {
  if (!data || !/^[a-f0-9-]{36}$/.test(data.requestId || '')) fail(400, 'Некорректный номер заявки.');
  if (!Array.isArray(data.files) || data.files.length > LIMITS.files) fail(400, 'Слишком много файлов.');
  const files = [];
  let config, total = 0;
  for (const file of data.files) {
    if (!file || typeof file.content !== 'string' || file.content.length > Math.ceil(LIMITS.fileBytes / 3) * 4
        || file.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) fail(400, 'Некорректное содержимое файла.');
    let bytes;
    try { bytes = decode64(file.content); } catch { fail(400, 'Некорректная кодировка файла.'); }
    total += bytes.length;
    if (total > LIMITS.totalBytes) fail(413, 'Вся папка должна быть не больше 20 МБ.');
    files.push({ name: file.name, size: bytes.length, content: file.content });
    if (file.name === 'cafe.json') {
      if (bytes.length > 65536) fail(400, 'cafe.json слишком большой (максимум 64 КБ).');
      try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail(400, 'Не удалось прочитать cafe.json как UTF-8 JSON.'); }
    } else if (!imageHeader(bytes, String(file.name))) fail(400, 'Один из файлов не является изображением указанного формата.');
  }
  let info;
  try { info = inspectPackage(data.id, files, config); }
  catch (error) { fail(400, error.message); }
  const gh = github(env), branch = encodeURIComponent(env.GITHUB_BRANCH || 'main');
  const ref = await gh(`/git/ref/heads/${branch}`);
  const head = ref.object.sha;
  const source = await gh(`/contents/venues/${info.id}?ref=${head}`, 'GET', undefined, true);
  const marker = `Secretbox-Upload: ${data.requestId}`;
  if (source) {
    const commits = await gh(`/commits?path=venues/${info.id}&sha=${head}&per_page=1`);
    if (commits[0]?.commit?.message?.includes(marker)) return { sha: commits[0].sha, id: info.id, reused: true };
    fail(409, 'Папка с таким именем уже существует. Для новой вкладки выберите другое имя.');
  }
  if (await gh(`/contents/coffee-menu/tabs/${info.id}?ref=${head}`, 'GET', undefined, true))
    fail(409, 'Вкладка с таким именем уже существует. Действующие меню не перезаписываются.');
  const parent = await gh(`/git/commits/${head}`);
  const entries = [];
  for (const file of files) {
    const blob = await gh('/git/blobs', 'POST', { encoding: 'base64', content: file.content });
    entries.push({ path: `venues/${info.id}/${file.name}`, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await gh('/git/trees', 'POST', { base_tree: parent.tree.sha, tree: entries });
  const commit = await gh('/git/commits', 'POST', {
    message: `Create venue ${info.id} via staff panel\n\n${marker}`, tree: tree.sha, parents: [head],
  });
  // Только fast-forward: параллельные изменения сотрудников и Actions не затираются.
  await gh(`/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
  return { sha: commit.sha, id: info.id, reused: false };
}

export function stageOf(run, jobs) {
  if (!run) return 'waiting';
  if (run.status === 'completed' && run.conclusion !== 'success') return run.conclusion === 'cancelled' ? 'cancelled' : 'failed';
  const deploy = jobs.find(j => j.name === 'deploy');
  if (run.status === 'completed') return deploy?.conclusion === 'success' ? 'published' : 'unchanged';
  if (deploy && ['in_progress', 'queued', 'waiting'].includes(deploy.status)) return 'publishing';
  const parse = jobs.find(j => j.name === 'parse');
  if (parse?.steps?.some(s => s.name === 'Распознать фото через Gemma' && s.status === 'in_progress')) return 'recognizing';
  if (parse?.status === 'in_progress') return 'preparing';
  return 'queued';
}
async function jobStatus(sha, env, retry = false) {
  const gh = github(env);
  const runs = await gh(`/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&event=push&per_page=10`);
  const run = runs.workflow_runs?.find(r => r.head_sha === sha && r.head_branch === (env.GITHUB_BRANCH || 'main'));
  if (retry) {
    if (!run || run.status !== 'completed' || run.conclusion === 'success') fail(409, 'Повтор доступен только для завершившейся с ошибкой или отменённой обработки.');
    await gh(`/actions/runs/${run.id}/rerun`, 'POST', {});
    return { stage: 'queued', url: run.html_url };
  }
  const jobs = run ? (await gh(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs || [] : [];
  return { stage: stageOf(run, jobs), url: run?.html_url || null,
    steps: jobs.flatMap(j => (j.steps || []).filter(s => !s.name.startsWith('Post ')).map(s => ({
      name: s.name, status: s.status, conclusion: s.conclusion,
    }))) };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const origins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (!origins.includes(origin)) return respond({ error: 'Источник запроса не разрешён.' }, 403);
    Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16 || !env.GITHUB_TOKEN || !env.LOGIN_LIMITER)
        fail(503, 'Панель ещё не настроена: администратору нужно подключить сервер и секреты.');
      if (!/^[\w.-]+$/.test(env.GITHUB_OWNER || '') || !/^[\w.-]+$/.test(env.GITHUB_REPO || '')) fail(503, 'Не настроен репозиторий.');
      const url = new URL(request.url);
      if (url.pathname === '/login' && request.method === 'POST') {
        const limit = await env.LOGIN_LIMITER.limit({ key: `login:${request.headers.get('CF-Connecting-IP') || 'unknown'}` });
        if (!limit.success) fail(429, 'Слишком много попыток входа. Подождите минуту.');
        const data = await bodyJSON(request, 2048);
        if (typeof data?.password !== 'string' || !await samePassword(data.password, env.ADMIN_PASSWORD)) fail(401, 'Неверный пароль.');
        return respond({ token: await session(env.ADMIN_PASSWORD), expires_in: SESSION_SECONDS });
      }
      if (!await authorized(request, env.ADMIN_PASSWORD)) fail(401, 'Войдите в панель. Сессия могла истечь.');
      if (url.pathname === '/session' && request.method === 'GET') return respond({ limits: LIMITS });
      if (url.pathname === '/uploads' && request.method === 'POST') {
        if (!env.UPLOAD_LIMITER || !(await env.UPLOAD_LIMITER.limit({ key: 'uploads' })).success)
          fail(429, 'Загрузки временно ограничены. Подождите минуту и повторите.');
        return respond(await createUpload(await bodyJSON(request, MAX_BODY), env), 201);
      }
      const match = url.pathname.match(/^\/jobs\/([a-f0-9]{40})(\/retry)?$/);
      if (match && request.method === (match[2] ? 'POST' : 'GET')) return respond(await jobStatus(match[1], env, Boolean(match[2])));
      fail(404, 'Не найдено.');
    } catch (error) {
      return respond({ error: error instanceof HttpError ? error.message : 'Сервер не смог выполнить запрос. Повторите позже.' },
        error instanceof HttpError ? error.status : 500);
    }
  },
};
