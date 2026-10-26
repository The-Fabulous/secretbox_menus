// Offline integration against the real site data: node coffee-menu/tests/api.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const site = path.resolve(__dirname, '..');
const base = 'https://example.test/secretbox_menus/';
const requests = [];
const context = vm.createContext({
  URL, console, document: { baseURI: base },
  fetch: async url => {
    const resolved = new URL(url, base);
    assert.ok(resolved.href.startsWith(base), `URL escaped site: ${url}`);
    requests.push(resolved.href);
    const file = path.join(site, decodeURIComponent(resolved.pathname.slice(new URL(base).pathname.length)));
    const text = await fs.readFile(file, 'utf8');
    return { ok: true, text: async () => text };
  },
});

(async () => {
  vm.runInContext(await fs.readFile(path.join(site, 'api.js'), 'utf8'), context);
  const api = vm.runInContext('API', context);
  const { cafes } = await api.getCafes();
  const index = JSON.parse(await fs.readFile(path.join(site, 'tabs/index.json'), 'utf8'));
  assert.equal(cafes.length, index.tabs.length);
  assert.equal(new Set(cafes.map(c => c.id)).size, cafes.length);
  const styles = await api.getStyles();
  let count = 0;
  for (const cafe of cafes) {
    const menu = await api.getMenu(cafe, styles);
    const folderURL = new URL('.', new URL(cafe.file, base)).href;
    if (cafe.logo) assert.ok(cafe.logo.startsWith(folderURL));
    const raw = JSON.parse(await fs.readFile(path.join(site, cafe.file), 'utf8'));
    assert.equal(menu.items.length, raw.items.length, `Lost items: ${cafe.id}`);
    for (const item of menu.items) {
      if (item.image) assert.ok(item.image.startsWith(folderURL), `Image escaped bundle: ${item.image}`);
    }
    count += menu.items.length;
  }
  assert.ok(requests.every(url => !url.includes('/data/cafes.json') && !url.includes('/cafes/')));
  console.log(`PASS: ${cafes.length} tabs, ${count} items, portable image/logo paths under GitHub Pages prefix.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
