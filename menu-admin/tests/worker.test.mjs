import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { stageOf } from '../worker.mjs';
import { inspectPackage } from '../../coffee-menu/admin/validation.mjs';

const origin = 'https://the-fabulous.github.io';
const env = { ADMIN_PASSWORD: 'test-only-password-012345', GITHUB_TOKEN: 'test-only-github-token',
  GITHUB_OWNER: 'The-Fabulous', GITHUB_REPO: 'secretbox_menus', GITHUB_BRANCH: 'main', ALLOWED_ORIGINS: origin,
  LOGIN_LIMITER: { limit: async () => ({ success: true }) }, UPLOAD_LIMITER: { limit: async () => ({ success: true }) } };
const head = 'a'.repeat(40), sha = 'b'.repeat(40);
const id = 'test_cafe', requestId = '11111111-2222-4333-8444-555555555555';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=';
const pkg = () => ({ id, requestId, files: [
  { name: 'cafe.json', content: Buffer.from(JSON.stringify({ name: 'Test Cafe', logo: null })).toString('base64') },
  { name: 'menu.png', content: png },
] });
const req = (path, method = 'GET', body, token, extra = {}) => new Request(`https://worker.test${path}`, {
  method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function login(custom = env) {
  const response = await worker.fetch(req('/login', 'POST', { password: env.ADMIN_PASSWORD }), custom);
  assert.equal(response.status, 200); return (await response.json()).token;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function fakeGitHub(options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    assert.ok(url.startsWith('https://api.github.com/repos/The-Fabulous/secretbox_menus/'));
    const path = new URL(url).pathname.replace('/repos/The-Fabulous/secretbox_menus', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method, body });
    if (path === '/git/ref/heads/main') return json({ object: { sha: head } });
    if (path === `/contents/venues/${id}`) return json([], options.exists ? 200 : 404);
    if (path === `/contents/coffee-menu/tabs/${id}`) return json({}, options.tabExists ? 200 : 404);
    if (path === '/commits') return json([{ sha, commit: { message: options.sameRequest ? `Secretbox-Upload: ${requestId}` : 'Other upload' } }]);
    if (path === `/git/commits/${head}`) return json({ tree: { sha: 'root-tree' } });
    if (path === '/git/blobs') return json({ sha: 'blob-' + calls.length }, 201);
    if (path === '/git/trees') return json({ sha: 'new-tree' }, 201);
    if (path === '/git/commits') return json({ sha }, 201);
    if (path === '/git/refs/heads/main') return json({}, options.conflict ? 422 : 200);
    if (path === '/actions/workflows/parse-menu.yml/runs') return json({ workflow_runs: options.runs || [] });
    if (path === '/actions/runs/42/jobs') return json({ jobs: options.jobs || [] });
    if (path === '/actions/runs/42/rerun') return new Response(null, { status: 201 });
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  return { calls, fetch };
}
async function usingGitHub(options, callback) {
  const fake = fakeGitHub(options), original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try { await callback(fake.calls); } finally { globalThis.fetch = original; }
}

test('protected entry: wrong origin, missing credentials, wrong password, rate limiting', async () => {
  assert.equal((await worker.fetch(req('/session', 'GET', undefined, undefined, { Origin: 'https://evil.test' }), env)).status, 403);
  assert.equal((await worker.fetch(req('/session'), env)).status, 401);
  assert.equal((await worker.fetch(req('/login', 'POST', { password: 'wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(req('/login', 'POST', { password: env.ADMIN_PASSWORD }), { ...env, ADMIN_PASSWORD: '' })).status, 503);
  assert.equal((await worker.fetch(req('/login', 'POST', { password: env.ADMIN_PASSWORD }), { ...env,
    LOGIN_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
});
test('signed session works, forgery and password rotation invalidate it', async () => {
  const token = await login();
  assert.equal((await worker.fetch(req('/session', 'GET', undefined, token), env)).status, 200);
  const [payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ scope: 'menu-admin', exp: 9999999999 })).toString('base64');
  assert.equal((await worker.fetch(req('/session', 'GET', undefined, `${changed}.${signature}`), env)).status, 401);
  assert.equal((await worker.fetch(req('/session', 'GET', undefined, token), { ...env, ADMIN_PASSWORD: 'another-test-password' })).status, 401);
  assert.ok(payload);
});
test('new upload writes only venues/<id> in one non-forced commit', async () => {
  const token = await login();
  await usingGitHub({}, async calls => {
    const response = await worker.fetch(req('/uploads', 'POST', pkg(), token), env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { sha, id, reused: false });
    const tree = calls.find(c => c.path === '/git/trees').body;
    assert.equal(tree.base_tree, 'root-tree');
    assert.deepEqual(tree.tree.map(f => f.path), [`venues/${id}/cafe.json`, `venues/${id}/menu.png`]);
    assert.equal(calls.filter(c => c.path === '/git/refs/heads/main').length, 1);
    assert.deepEqual(calls.at(-1).body, { sha, force: false });
  });
});
test('repeating a completed upload is idempotent; existing venues/tabs cannot be replaced', async () => {
  const token = await login();
  for (const options of [{ exists: true, sameRequest: true }, { exists: true }, { tabExists: true }]) {
    await usingGitHub(options, async calls => {
      const response = await worker.fetch(req('/uploads', 'POST', pkg(), token), env);
      assert.equal(response.status, options.sameRequest ? 201 : 409);
      assert.ok(calls.every(c => c.method === 'GET'));
    });
  }
});
test('unsafe input, unsupported file and wrong image content cause no GitHub writes', async () => {
  const token = await login();
  for (const change of [p => p.id = '../escape', p => p.files[0].name = '../cafe.json',
    p => p.files[1].name = '.env', p => p.files[1].content = btoa('not an image')]) {
    const data = pkg(); change(data);
    await usingGitHub({}, async calls => {
      assert.equal((await worker.fetch(req('/uploads', 'POST', data, token), env)).status, 400);
      assert.equal(calls.length, 0);
    });
  }
});
test('large bodies and upload rate limits are rejected before GitHub', async () => {
  const token = await login();
  assert.equal((await worker.fetch(req('/uploads', 'POST', {}, token, { 'Content-Length': '40000000' }), env)).status, 413);
  assert.equal((await worker.fetch(req('/uploads', 'POST', pkg(), token), { ...env,
    UPLOAD_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
});
test('concurrent main change is a conflict, never a forced overwrite', async () => {
  const token = await login();
  await usingGitHub({ conflict: true }, async calls => {
    assert.equal((await worker.fetch(req('/uploads', 'POST', pkg(), token), env)).status, 409);
    assert.equal(calls.at(-1).body.force, false);
  });
});
test('status distinguishes queued, parsing, failure and actual publication', async () => {
  assert.equal(stageOf(null, []), 'waiting');
  assert.equal(stageOf({ status: 'queued' }, []), 'queued');
  assert.equal(stageOf({ status: 'in_progress' }, [{ name: 'parse', status: 'in_progress', steps: [
    { name: 'Распознать фото через Gemma', status: 'in_progress' }] }]), 'recognizing');
  assert.equal(stageOf({ status: 'completed', conclusion: 'failure' }, []), 'failed');
  assert.equal(stageOf({ status: 'completed', conclusion: 'success' }, [{ name: 'deploy', conclusion: 'skipped' }]), 'unchanged');
  assert.equal(stageOf({ status: 'completed', conclusion: 'success' }, [{ name: 'deploy', conclusion: 'success' }]), 'published');
});
test('retry is restricted to the matching failed parse workflow and handles empty GitHub responses', async () => {
  const token = await login();
  const run = { id: 42, head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'failure' };
  await usingGitHub({ runs: [run] }, async calls => {
    assert.equal((await worker.fetch(req(`/jobs/${sha}/retry`, 'POST', {}, token), env)).status, 200);
    assert.equal(calls.at(-1).path, '/actions/runs/42/rerun');
  });
  await usingGitHub({ runs: [{ ...run, head_sha: head }] }, async calls => {
    assert.equal((await worker.fetch(req(`/jobs/${sha}/retry`, 'POST', {}, token), env)).status, 409);
    assert.ok(calls.every(c => c.method === 'GET'));
  });
});
test('configuration validation checks logo, limits and optional modules', () => {
  const files = [{ name: 'cafe.json', size: 100 }, { name: 'menu.png', size: 100 }];
  assert.equal(inspectPackage(id, files, { name: 'Test', modules: { pickup: { enabled: true } } }).pickup, true);
  assert.throws(() => inspectPackage(id, files, { name: 'Test', logo: 'missing.png' }));
  assert.throws(() => inspectPackage(id, files, { name: 'Test', modules: { delivery: { enabled: 'true' } } }));
  assert.throws(() => inspectPackage(id, [...files, { name: 'MENU.png', size: 100 }], { name: 'Test' }));
});
