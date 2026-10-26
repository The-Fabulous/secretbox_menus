// Local UI test only. No GitHub/Gemma access and no changes to the repository.
// node menu-admin/tests/preview.mjs --demo
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker.mjs';
if (!process.argv.includes('--demo')) throw new Error('This server requires --demo; it never runs against live GitHub.');
const site = fileURLToPath(new URL('../../coffee-menu/', import.meta.url));
const origin = 'http://127.0.0.1:8767';
const sha = 'b'.repeat(40), head = 'a'.repeat(40);
let active = false, poll = 0;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.github.com/repos/The-Fabulous/secretbox_menus/')) throw new Error('Network disabled in UI test');
  const target = new URL(url).pathname.replace('/repos/The-Fabulous/secretbox_menus', '');
  const result = value => Response.json(value);
  if (target === '/git/ref/heads/main') return result({ object: { sha: head } });
  if (target.startsWith('/contents/')) return new Response('{}', { status: 404 });
  if (target === `/git/commits/${head}`) return result({ tree: { sha: 'tree' } });
  if (target === '/git/blobs') return result({ sha: 'blob' });
  if (target === '/git/trees') return result({ sha: 'tree' });
  if (target === '/git/commits') return result({ sha });
  if (target === '/git/refs/heads/main') { active = true; poll = 0; return result({}); }
  if (target.includes('/workflows/parse-menu.yml/runs')) {
    poll++;
    return result({ workflow_runs: active ? [{ id: 42, head_sha: sha, head_branch: 'main',
      status: poll >= 4 ? 'completed' : poll === 1 ? 'queued' : 'in_progress', conclusion: poll >= 4 ? 'success' : null,
      html_url: 'https://github.com/The-Fabulous/secretbox_menus/actions/runs/42' }] : [] });
  }
  if (target === '/actions/runs/42/jobs') return result({ jobs: poll < 3
    ? [{ name: 'parse', status: poll === 1 ? 'queued' : 'in_progress', steps: poll === 1 ? [] : [
      { name: 'Распознать фото через Gemma', status: 'in_progress' }] }]
    : [{ name: 'deploy', status: poll >= 4 ? 'completed' : 'in_progress', conclusion: poll >= 4 ? 'success' : null, steps: [] }] });
  throw new Error(`Unexpected simulated route ${target}`);
};
const env = { ADMIN_PASSWORD: 'demo-password-12345', GITHUB_TOKEN: 'not-a-real-token', GITHUB_OWNER: 'The-Fabulous',
  GITHUB_REPO: 'secretbox_menus', GITHUB_BRANCH: 'main', ALLOWED_ORIGINS: origin,
  LOGIN_LIMITER: { limit: async () => ({ success: true }) }, UPLOAD_LIMITER: { limit: async () => ({ success: true }) } };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
http.createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (url.pathname.startsWith('/__admin/')) {
      const chunks = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('Too large'); chunks.push(chunk); }
      const headers = new Headers(incoming.headers);
      headers.set('Origin', origin);
      const request = new Request(origin + url.pathname.replace('/__admin', '') + url.search, {
        method: incoming.method, headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname === '/data/config.json') {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ admin_api_url: origin + '/__admin' })); return;
    }
    const filename = path.resolve(site, '.' + decodeURIComponent(url.pathname === '/' ? '/admin.html' : url.pathname));
    if (!filename.startsWith(path.resolve(site) + path.sep)) throw new Error('Invalid path');
    let bytes = await fs.readFile(filename);
    if (filename.endsWith('admin.html')) bytes = Buffer.from(bytes.toString().replace('<main class="admin-main">',
      '<main class="admin-main"><p class="demo-note">Локальный тест интерфейса. GitHub и Gemma заменены тестовыми ответами; реальная вкладка не создаётся.</p>'));
    outgoing.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); outgoing.end(bytes);
  } catch { outgoing.writeHead(404); outgoing.end('Not found'); }
}).listen(8767, '127.0.0.1', () => console.log(`UI test: ${origin}/admin.html | password: demo-password-12345 | no external writes`));
