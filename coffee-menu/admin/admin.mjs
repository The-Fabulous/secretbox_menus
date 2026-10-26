import { inspectPackage, VALID_ID } from './validation.mjs';

const $ = id => document.getElementById(id);
const JOB_KEY = 'secretbox:admin:last-job';
const STAGES = {
  waiting: ['Исходники загружены', 'Ожидаем запуска обработки. Обычно это занимает меньше минуты.'],
  queued: ['Заявка в очереди', 'Обработка начнётся после предыдущей заявки. Можно оставить страницу открытой или вернуться позже.'],
  preparing: ['Готовим обработку', 'Сервер подготавливает драйвер и изображения.'],
  recognizing: ['Распознаём меню', 'Читаем позиции и цены, вырезаем фотографии. Большие меню могут обрабатываться несколько минут.'],
  publishing: ['Публикуем вкладку', 'Готовые ресурсы собраны. Обновляем сайт.'],
  published: ['Новая вкладка опубликована', 'Откройте меню и проверьте распознанные названия и цены.'],
  unchanged: ['Обработка завершена', 'Новой публикации не было. Подробности доступны в журнале обработки.'],
  failed: ['Обработка не завершилась', 'Исходники сохранены. Откройте журнал, чтобы узнать причину; после устранения проблемы обработку можно повторить.'],
  cancelled: ['Обработка отменена', 'Возможно, очередь была заменена более новой заявкой. Исходники сохранены — обработку можно повторить.'],
};
const TERMINAL = new Set(['published', 'unchanged', 'failed', 'cancelled']);
let endpoint = '', token = '', files = [], config = null, ready = false, busy = false, timer, polling = false;
let requestId = crypto.randomUUID(), selection = 0, pollFailures = 0, job = null;
const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
const setText = (id, text) => { $(id).textContent = text; };
function saveJob() {
  try { if (job) localStorage.setItem(JOB_KEY, JSON.stringify(job)); else localStorage.removeItem(JOB_KEY); } catch { /* private mode */ }
}
function restoreJob() {
  try {
    const saved = JSON.parse(localStorage.getItem(JOB_KEY));
    if (saved && /^[a-f0-9]{40}$/.test(saved.sha) && VALID_ID.test(saved.id)) job = saved;
  } catch { /* no saved job */ }
}
function showLogin() {
  token = '';
  clearTimeout(timer);
  $('workspace').hidden = true;
  $('logout').hidden = true;
  $('loginForm').hidden = false;
}
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(endpoint + path, { method, cache: 'no-store', credentials: 'omit',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
  } catch { throw new Error('Нет ответа от сервера. Проверьте соединение и повторите.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ.'); }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') { showLogin(); setText('loginError', 'Сессия истекла. Войдите, чтобы продолжить.'); }
    throw new Error(data.error || `Ошибка сервера: ${response.status}`);
  }
  return data;
}
function validate() {
  ready = false;
  $('preview').hidden = true;
  setText('packageError', '');
  if (files.length && config) {
    try {
      const info = inspectPackage($('cafeId').value.trim(), files, config);
      ready = true;
      $('preview').hidden = false;
      setText('venueName', info.name);
      setText('packageSummary', `Скрины меню: ${info.imageCount} · Файлы: ${files.length} · ${sizeLabel(info.bytes)}`);
      setText('moduleSummary', `Самовывоз: ${info.pickup ? 'включён' : 'выключен'} · Доставка: ${info.delivery ? 'включена' : 'выключена'}`);
      $('fileList').replaceChildren(...files.map(file => {
        const li = document.createElement('li'), name = document.createElement('span'), size = document.createElement('small');
        name.textContent = file.name; size.textContent = sizeLabel(file.size); li.append(name, size); return li;
      }));
    } catch (error) { setText('packageError', error.message); }
  }
  $('createButton').disabled = !ready || busy || Boolean(job);
}
$('folder').addEventListener('change', async event => {
  const version = ++selection;
  files = []; config = null; ready = false; requestId = crypto.randomUUID();
  validate(); setText('uploadError', '');
  const selected = [...event.target.files].filter(f => !['.DS_Store', 'Thumbs.db', '.gitkeep'].includes(f.name));
  if (!selected.length) return;
  try {
    const paths = selected.map(f => (f.webkitRelativePath || f.name).split('/'));
    if (paths.some(p => p.length !== 2 || p[0] !== paths[0][0])) throw new Error('Выберите одну папку заведения. Файлы должны лежать прямо в ней, без вложенных папок.');
    $('cafeId').value = paths[0][0].toLowerCase().replace(/-/g, '_');
    const settings = selected.find(f => f.name === 'cafe.json');
    if (!settings) throw new Error('В выбранной папке нет cafe.json. Скачайте пример конфига ниже.');
    if (settings.size > 65536) throw new Error('cafe.json слишком большой (максимум 64 КБ).');
    const parsed = JSON.parse((await settings.text()).replace(/^\uFEFF/, ''));
    if (selection !== version) return;
    files = selected; config = parsed; validate();
  } catch (error) {
    if (selection !== version) return;
    setText('packageError', error instanceof SyntaxError ? 'Ошибка JSON в cafe.json. Проверьте кавычки и запятые.' : error.message);
  }
});
$('cafeId').addEventListener('input', () => { requestId = crypto.randomUUID(); validate(); });

function stageView(stage, detail) {
  const words = STAGES[stage];
  setText('statusTitle', words?.[0] || 'Передаём исходники');
  setText('statusDetail', detail || words?.[1] || 'После загрузки начнётся серверная обработка.');
  const current = stage === 'uploading' ? 0 : ['waiting', 'queued', 'preparing', 'recognizing'].includes(stage) ? 1 : 2;
  [...document.querySelectorAll('.pipeline li')].forEach((li, index) => {
    li.classList.toggle('done', stage === 'published' || index < current);
    li.classList.toggle('active', !TERMINAL.has(stage) && index === current);
  });
  $('retry').hidden = !['failed', 'cancelled'].includes(stage);
  $('newUpload').hidden = !TERMINAL.has(stage);
  $('openMenu').hidden = stage !== 'published';
  if (job) $('openMenu').href = `./?cafe=${encodeURIComponent(job.id)}`;
}
function runLink(url) {
  const safe = typeof url === 'string' && /^https:\/\/github\.com\/The-Fabulous\/secretbox_menus\/actions\/runs\/\d+$/.test(url);
  $('runLink').hidden = !safe;
  if (safe) $('runLink').href = url;
}
async function poll() {
  clearTimeout(timer);
  if (!job || !token || polling) return;
  polling = true; $('refresh').disabled = true;
  const current = job.sha;
  try {
    const status = await api(`/jobs/${current}`);
    if (!token || !job || job.sha !== current) return;
    job.stage = status.stage; saveJob(); pollFailures = 0;
    const waitingLong = status.stage === 'waiting' && Date.now() - job.started > 5 * 60 * 1000;
    stageView(status.stage, waitingLong ? 'Исходники сохранены, но задача пока не появилась. Проверьте, включены ли Actions, или обновите статус позже.' : undefined);
    runLink(status.url);
    $('jobSteps').replaceChildren(...(status.steps || []).filter(step => step.status === 'in_progress' || step.conclusion === 'failure').map(step => {
      const li = document.createElement('li'); li.textContent = `${step.conclusion === 'failure' ? '✕' : '◌'} ${step.name}`; return li;
    }));
    if (!TERMINAL.has(status.stage) && !waitingLong) timer = setTimeout(poll, 10000);
  } catch (error) {
    if (token) {
      setText('statusDetail', `${error.message} Обработка на сервере может продолжаться.`);
      if (++pollFailures < 5) timer = setTimeout(poll, 15000);
    }
  } finally { polling = false; $('refresh').disabled = false; }
}
async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { name: file.name, content: btoa(binary) };
}
function sendUpload(payload) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint + '/uploads');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 240000;
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) $('uploadProgress').value = Math.round(e.loaded / e.total * 100);
      setText('statusDetail', e.loaded === e.total ? 'Файлы переданы. Сервер сохраняет папку; это может занять ещё минуту.' : 'Передаём скриншоты и конфиг на сервер.');
    };
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Соединение прервалось. Повторите загрузку этой же папки: номер заявки сохранён, дубля не будет.'));
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 401) { showLogin(); setText('loginError', 'Войдите снова, затем повторите загрузку.'); }
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error || 'Загрузка не завершилась.');
        resolve(data);
      } catch (error) { reject(error); }
    };
    xhr.send(JSON.stringify(payload));
  });
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginButton').disabled = true; setText('loginError', '');
  const password = $('password').value;
  try {
    const result = await api('/login', { method: 'POST', body: { password } });
    token = result.token; $('password').value = '';
    $('loginForm').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    if (job) { $('uploadFields').disabled = true; $('refresh').hidden = false; stageView(job.stage || 'waiting'); await poll(); }
    validate();
  } catch (error) { setText('loginError', error.message); }
  finally { $('loginButton').disabled = false; }
});
$('uploadForm').addEventListener('submit', async event => {
  event.preventDefault(); validate();
  if (!ready || busy || job || !token) return;
  busy = true; $('uploadFields').disabled = true; $('logout').disabled = true;
  $('uploadProgress').hidden = false; $('uploadProgress').value = 0;
  setText('uploadError', ''); stageView('uploading');
  try {
    const encoded = [];
    for (const file of files) encoded.push(await encodeFile(file));
    const result = await sendUpload({ id: $('cafeId').value.trim(), requestId, files: encoded });
    if (!/^[a-f0-9]{40}$/.test(result.sha) || !VALID_ID.test(result.id)) throw new Error('Сервер вернул некорректный номер обработки.');
    job = { sha: result.sha, id: result.id, started: Date.now(), stage: 'waiting' };
    saveJob(); $('refresh').hidden = false; stageView('waiting'); await poll();
  } catch (error) {
    setText('uploadError', error.message); setText('statusTitle', 'Загрузка требует внимания');
    setText('statusDetail', 'Исправьте причину и повторите. Успешное создание вкладки ещё не подтверждено.');
  } finally {
    busy = false; $('uploadProgress').hidden = true; $('logout').disabled = false;
    $('uploadFields').disabled = Boolean(job); validate();
  }
});
$('logout').addEventListener('click', showLogin);
$('refresh').addEventListener('click', () => { pollFailures = 0; poll(); });
$('retry').addEventListener('click', async () => {
  if (!job || busy) return;
  $('retry').disabled = true;
  try {
    await api(`/jobs/${job.sha}/retry`, { method: 'POST', body: {} });
    job.stage = 'queued'; job.started = Date.now(); saveJob(); stageView('queued');
    clearTimeout(timer); timer = setTimeout(poll, 10000);
  } catch (error) { setText('statusDetail', error.message); }
  finally { $('retry').disabled = false; }
});
$('newUpload').addEventListener('click', () => {
  clearTimeout(timer); job = null; saveJob(); requestId = crypto.randomUUID();
  files = []; config = null; $('uploadForm').reset(); $('uploadFields').disabled = false; validate();
  for (const id of ['newUpload', 'retry', 'refresh', 'runLink', 'openMenu']) $(id).hidden = true;
  $('jobSteps').replaceChildren(); setText('uploadError', '');
  document.querySelectorAll('.pipeline li').forEach(li => li.classList.remove('done', 'active'));
  setText('statusTitle', 'Всё начинается с папки'); setText('statusDetail', 'Выберите папку следующего заведения.');
});

try {
  const response = await fetch('data/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Не найден config.json.');
  const settings = await response.json();
  if (settings.admin_api_url) {
    const parsed = new URL(settings.admin_api_url);
    const local = ['localhost', '127.0.0.1'].includes(location.hostname) && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('Сервер панели должен использовать HTTPS.');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Некорректный адрес сервера панели.');
    endpoint = parsed.href.replace(/\/$/, ''); restoreJob(); showLogin();
  } else { $('setup').hidden = false; }
} catch (error) {
  $('setup').hidden = false; $('setup').querySelector('p').textContent = error.message;
}
