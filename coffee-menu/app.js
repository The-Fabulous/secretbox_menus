(() => {
  'use strict';

  const { t: T, L } = I18N;

  // Кнопка «Проверить API» (видна только персоналу: ?staff=1) спрашивает не Gemma напрямую,
  // а сервер-посредник (gemma-health/worker.js, адрес — в data/config.json). Ключ Gemma хранится
  // только у посредника — в браузер, на сайт и в репозиторий он не попадает.
  let CONFIG = { gemmaHealthUrl: null, gemmaUrl: 'https://llm.alem.ai/v1' };
  const API_TIMEOUT_SEC = 25;

  // Заполняется после загрузки данных (см. init)
  let STYLES = {};        // общие стили разделов (data/categories.json)
  let TAGS = {};          // метки позиций (data/tags.json): id → метка
  let BRAND = null;       // { name, logo } — для экрана выбора кофейни
  let MENU = null;        // { cafe, currency, categories, items }
  let CATS = {};          // id раздела → раздел текущей кофейни
  let BY_ID = {};         // id позиции → позиция
  let money = null;

  const state = {
    order: {},            // { 'id:variantIndex[:добавки]': qty }
    comment: '',          // комментарий к заказу
    dineIn: 'hall',       // 'hall' | 'togo' | 'pickup' | 'delivery'
    contact: { phone: '', address: '', details: '' },
    checkoutErrors: {},
    when: 'asap',         // 'asap' | минуты
    table: null,          // номер стола из QR-кода (?table=5)
    stack: [],            // открытые окна: product | order | filters | profile
    spy: null,            // раздел, который сейчас на экране
    search: { open: false, q: '' },
    filters: { tags: [], max: null },  // метки (все должны быть у позиции) и цена «до»
    favs: [],             // избранное — id позиций
    history: [],          // прошлые заказы этой кофейни
    picker: null,         // { cafes, menus } — экран выбора кофейни
    error: null,
    staff: false,         // режим персонала: кнопка «Проверить API»
    api: { status: 'unknown', message: '', at: null },  // unknown | checking | ok | fail
  };

  const $ = sel => document.querySelector(sel);
  const overlay = $('#overlay');
  const sheet = $('#sheet');
  const cartBar = $('#cartBar');
  const tabsWrap = $('#tabsWrap');

  // ───────── helpers

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ESC[ch]);
  const decode = s => { try { return decodeURIComponent(s); } catch { return ''; } };

  const fmt = n => money.format(Math.round(n));
  const minPrice = item => Math.min(...item.sizes.map(s => s.price));
  const catOf = item => CATS[item.cat] || STYLES.other;
  const isDrink = item => catOf(item).kind === 'drink';
  const qtyOf = key => state.order[key] || 0;
  const priceLabel = item => (item.sizes.length > 1 ? T('from_price', { p: fmt(minPrice(item)) }) : fmt(minPrice(item)));
  const specialLabel = item => T(`special_${{ drink: 'drink', sweet: 'sweet', set: 'set' }[catOf(item).kind] || 'food'}`);
  const sizeLabel = (s, i) => s.amount || T('variant', { n: i + 1 });
  const itemTags = item => item.tags.map(id => TAGS[id]).filter(Boolean);

  function makeMoney(currency) {
    try {
      return new Intl.NumberFormat(I18N.locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
    } catch {
      return { format: n => `${n.toLocaleString(I18N.locale)} ${currency}` };
    }
  }

  // Всё, что гость сохраняет, живёт только в его браузере. Ключи — с id кофейни.
  const storeKey = name => `${name}:${MENU.cafe.id}`;
  function readStore(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ───────── добавки и ключ позиции в заказе
  // Ключ: id:вариант[:добавки], добавки — «группа.опция» через запятую, без вариантов по умолчанию.
  // Так «капучино 300 мл на овсяном» и «капучино 300 мл» — разные строки заказа.

  const defaultSel = item => Object.fromEntries(item.mods.map(g =>
    [g.id, g.type === 'single' ? g.options.filter(o => o.default).map(o => o.id) : []]));

  // порядок — как в меню, а не как нажимали: «ваниль + карамель» и «карамель + ваниль» — одна строка заказа
  function modsKey(item, sel) {
    const parts = [];
    for (const g of item.mods) {
      const picked = sel[g.id] || [];
      for (const o of g.options) {
        if (picked.includes(o.id) && !(g.type === 'single' && o.default)) parts.push(`${g.id}.${o.id}`);
      }
    }
    return parts.join(',');
  }

  function parseMods(item, str) {
    const sel = defaultSel(item);
    for (const token of String(str || '').split(',').filter(Boolean)) {
      const [gid, oid] = token.split('.');
      const g = item.mods.find(x => x.id === gid);
      if (!g || !g.options.some(o => o.id === oid)) continue; // добавку убрали из меню — пропускаем
      if (g.type === 'single') sel[g.id] = [oid];
      else if (!sel[g.id].includes(oid) && (!g.max || sel[g.id].length < g.max)) sel[g.id].push(oid);
    }
    return sel;
  }

  const chosen = (item, sel) => item.mods.flatMap(g =>
    (sel[g.id] || []).map(id => ({ g, o: g.options.find(x => x.id === id) })).filter(x => x.o));

  const unitPrice = (item, size, sel) => item.sizes[size].price + chosen(item, sel).reduce((s, x) => s + x.o.price, 0);

  // подпись добавок для заказа: «Овсяное · Ванильный»
  const modsLabel = (item, sel) => chosen(item, sel)
    .filter(x => !(x.g.type === 'single' && x.o.default))
    .map(x => L(x.o, 'name')).join(' · ');

  const keyOf = (id, size = 0, mods = '') => `${encodeURIComponent(id)}:${size}${mods ? `:${encodeURIComponent(mods)}` : ''}`;

  function parseKey(key) {
    const [id, size, mods] = String(key).split(':');
    const item = BY_ID[decode(id)];
    const sel = item ? parseMods(item, decode(mods || '')) : {};
    return { item, size: Number(size) || 0, sel };
  }

  // из браузера берём только целые положительные количества — испорченная запись не должна ломать подсчёт
  function loadOrder() {
    const raw = readStore(storeKey('order'), {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw)
      .map(([key, q]) => [key, Math.floor(Number(q))])
      .filter(([, q]) => Number.isFinite(q) && q > 0 && q < 1000));
  }
  const saveOrder = () => writeStore(storeKey('order'), state.order);
  const saveComment = () => writeStore(storeKey('comment'), state.comment);

  // имя гостя — одно на все кофейни
  const guestName = () => { const v = readStore('guest:name', ''); return typeof v === 'string' ? v : ''; };

  // позиции, которых больше нет в меню, из заказа выпадают; цены всегда актуальные из данных
  function orderLines() {
    return Object.entries(state.order)
      .map(([key, qty]) => ({ key, qty, ...parseKey(key) }))
      .filter(l => l.qty > 0 && l.item && l.item.sizes[l.size])
      .map(l => ({ ...l, unit: unitPrice(l.item, l.size, l.sel) }));
  }
  const orderCount = () => orderLines().reduce((s, l) => s + l.qty, 0);
  const orderTotal = () => orderLines().reduce((s, l) => s + l.unit * l.qty, 0);
  const pickupSettings = () => PickupModule.config(MENU.cafe.modules?.pickup);
  const deliverySettings = () => DeliveryModule.config(MENU.cafe.modules?.delivery);
  const orderModes = () => ['hall', 'togo', ...(pickupSettings().enabled ? ['pickup'] : []),
    ...(deliverySettings().enabled ? ['delivery'] : [])];
  const isRemoteOrder = () => ['pickup', 'delivery'].includes(state.dineIn);
  const modeLabel = (mode, table) => mode === 'hall' && table ? T('hall_table', { n: table }) : T(mode);
  function checkoutQuote() {
    const subtotal = orderTotal(), prep = estimateMinutes();
    if (state.dineIn === 'pickup') return PickupModule.quote(pickupSettings(), subtotal, prep);
    if (state.dineIn === 'delivery') return DeliveryModule.quote(deliverySettings(), subtotal, prep);
    return { fee: 0, total: subtotal, minimum: 0, remaining: 0, minutes: prep };
  }

  // ───────── фильтры

  const filtersActive = () => state.filters.tags.length + (state.filters.max !== null ? 1 : 0);
  const passFilters = (item, f = state.filters) =>
    f.tags.every(t => item.tags.includes(t)) && (f.max === null || minPrice(item) <= f.max);
  const visibleItems = () => MENU.items.filter(i => passFilters(i));

  function priceBounds() {
    const prices = MENU.items.map(minPrice);
    const step = 100;
    return { min: Math.floor(Math.min(...prices) / step) * step, max: Math.ceil(Math.max(...prices) / step) * step, step };
  }

  // ───────── шаблоны

  // Иконка раздела на цветном фоне; если по ссылке image_url есть фото — оно ложится сверху.
  // Фото ещё нет — img сам себя убирает, и остаётся иконка.
  function pic(item, cls = '') {
    const cat = catOf(item);
    const [c1, c2] = cat.colors;
    return `
      <div class="pic ${cls}" style="--c1:${esc(c1)};--c2:${esc(c2)}">
        <span>${esc(item.icon || cat.emoji)}</span>
        ${item.image && cls === 'xl' ? `<img class="pic-blur" src="${esc(item.image)}" alt="" aria-hidden="true" onerror="this.remove()">` : ''}
        ${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </div>`;
  }

  const BEAN_MARK = `
    <svg class="logo-mark" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="var(--accent)" stroke="none"/>
      <ellipse cx="24" cy="24" rx="9" ry="13" fill="#fff8f0" stroke="none" transform="rotate(30 24 24)"/>
      <path d="M19 14c5 5 5 15 10 20" stroke="var(--accent)" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    </svg>`;

  const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
  const FILTER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';
  const HEART_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg>';

  function logo(src, name, cls) {
    return src
      ? `<img class="${cls}" src="${esc(src)}" alt="${esc(name)}">`
      : `<span class="${cls} logo-letter">${esc(name.trim().charAt(0).toUpperCase() || '☕')}</span>`;
  }

  const tagChip = (tag, cls = 'tag') =>
    `<span class="${cls}" ${tag.color ? `style="--tag:${esc(tag.color)}"` : ''}>${esc(tag.emoji)} ${esc(L(tag, 'name'))}</span>`;

  function favButton(item, cls = '') {
    const on = state.favs.includes(item.id);
    return `<button class="fav-btn ${cls} ${on ? 'on' : ''}" type="button" data-fav="${esc(item.id)}"
              aria-pressed="${on}" aria-label="${esc(T(on ? 'fav_remove' : 'fav_add'))}">${HEART_ICON}</button>`;
  }

  // Кнопка «В заказ» или счётчик. Обновляется через updateSlots() без перерисовки карточек.
  function control(key, variant) {
    const q = qtyOf(key);
    const cls = variant === 'card' ? '' : variant; // «card» — уже класс карточки, на кнопку его не вешаем
    if (!q) {
      let label = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>${T('add')}`;
      if (variant === 'big') {
        const { item, size, sel } = parseKey(key);
        label = `${T('add_to_order')} <span class="btn-sub">${fmt(unitPrice(item, size, sel))}</span>`;
      }
      return `<button class="btn-add ${cls}" type="button" data-add="${esc(key)}">${label}</button>`;
    }
    return `
      <div class="stepper ${cls}">
        <button type="button" data-dec="${esc(key)}" aria-label="${esc(T('remove_one'))}">−</button>
        <span>${variant === 'big' ? T('in_order', { n: q }) : q}</span>
        <button type="button" data-inc="${esc(key)}" aria-label="${esc(T('add_one'))}">+</button>
      </div>`;
  }
  const slot = (key, variant) => `<div class="slot" data-slot="${esc(key)}" data-variant="${variant}">${control(key, variant)}</div>`;

  function card(item) {
    const desc = L(item, 'desc');
    const tag = itemTags(item)[0];
    return `
      <article class="card" data-open="${esc(item.id)}" tabindex="0" aria-label="${esc(L(item, 'name'))}">
        <div class="card-pic">
          ${pic(item)}
          ${tag ? tagChip(tag, 'tag tag-on-pic') : ''}
          ${favButton(item)}
        </div>
        <div class="card-body">
          <h3 class="card-title">${esc(L(item, 'name'))}</h3>
          ${desc ? `<p class="card-short">${esc(desc)}</p>` : ''}
          <div class="card-price"><b>${priceLabel(item)}</b></div>
          ${slot(keyOf(item.id), 'card')}
        </div>
      </article>`;
  }

  // ───────── шапка

  function langSwitch() {
    const cur = I18N.LANGS.find(l => l.id === I18N.lang);
    return `
      <div class="lang">
        <button class="lang-btn" type="button" data-lang-toggle aria-haspopup="true" aria-expanded="false" aria-label="${esc(T('language'))}">
          ${cur.label}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="lang-menu" role="menu" hidden>
          ${I18N.LANGS.map(l => `
            <button type="button" role="menuitemradio" aria-checked="${l.id === I18N.lang}" class="${l.id === I18N.lang ? 'active' : ''}" data-lang="${l.id}">
              <b>${l.label}</b>${l.name}
            </button>`).join('')}
        </div>
      </div>`;
  }

  function renderHeader(cafe, canSwitch) {
    const name = cafe ? cafe.name : BRAND.name;
    const addr = cafe && (cafe.address || cafe.city);
    const sub = cafe ? [cafe.address && cafe.city, cafe.hours].filter(Boolean).join(' · ') : '';
    const mapQuery = cafe ? encodeURIComponent([cafe.city, cafe.address].filter(Boolean).join(', ')) : '';
    document.title = cafe ? `${cafe.name} — ${BRAND.name}` : BRAND.name;

    $('#topbar').innerHTML = `
      <div class="top-left">
        ${addr ? `
          <a class="address" href="https://2gis.kz/search/${mapQuery}" target="_blank" rel="noopener" title="${esc(T('open_map'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.6"/></svg>
            <span class="address-text">
              <b>${esc(cafe.address || cafe.city)}</b>
              ${sub ? `<small>${esc(sub)}</small>` : ''}
            </span>
          </a>` : ''}
        ${cafe && state.table ? `<span class="table-pill">🪑 ${esc(T('table', { n: state.table }))}</span>` : ''}
        ${state.staff ? `
          <button class="api-chip" type="button" data-api-open title="${esc(T('api_title'))}">
            <span class="api-dot ${state.api.status}"></span>${T('api_chip')}
          </button>` : ''}
      </div>

      <a class="logo" href="${canSwitch ? './' : '#'}" ${canSwitch ? `title="${esc(T('switch_cafe'))}"` : ''}>
        ${cafe ? logo(cafe.logo, name, 'logo-mark') : BEAN_MARK}
        <span class="logo-text">${esc(name)}</span>
      </a>

      <div class="top-right">
        ${langSwitch()}
        <button class="avatar" type="button" ${cafe ? 'data-profile' : 'disabled'} aria-label="${esc(T('profile'))}">
          <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6d7b8'/><stop offset='1' stop-color='%23d79a63'/></linearGradient></defs><rect width='64' height='64' fill='url(%23g)'/><circle cx='32' cy='26' r='11' fill='%23fff8f0'/><path d='M12 60c2-12 10-18 20-18s18 6 20 18' fill='%23fff8f0'/></svg>" alt="">
        </button>
      </div>`;
  }

  const refreshHeader = () => (MENU ? renderHeader(MENU.cafe, canSwitchCafe) : renderHeader(null, false));

  // фирменный цвет кофейни; от него в styles.css считаются тёмный и светлый оттенки
  function applyTheme(cafe) {
    const root = document.documentElement.style;
    if (cafe && cafe.accent) root.setProperty('--accent', cafe.accent);
    else root.removeProperty('--accent');
  }

  // ───────── главный экран

  function renderToday() {
    const specials = MENU.items.filter(i => i.special);
    $('#today').hidden = !specials.length;
    if (!specials.length) return;

    $('#todayTitle').textContent = T('today');
    $('#todayDate').textContent = I18N.formatDate(new Date());

    $('#specials').innerHTML = specials.map(item => `
      <article class="special" data-open="${esc(item.id)}" tabindex="0">
        <div class="special-pic">${pic(item)}</div>
        <div class="special-body">
          <span class="special-label">${specialLabel(item)}</span>
          <h3>${esc(L(item, 'name'))}</h3>
          ${L(item, 'desc') ? `<p>${esc(L(item, 'desc'))}</p>` : ''}
          <div class="special-foot">
            <div class="card-price"><b>${priceLabel(item)}</b></div>
            ${slot(keyOf(item.id), 'card')}
          </div>
        </div>
      </article>`).join('');
  }

  // разделы, в которых есть позиции (с учётом фильтров)
  function menuCategories(items = visibleItems()) {
    const used = new Set(items.map(i => i.cat));
    return MENU.categories.filter(c => used.has(c.id));
  }

  // Лента: поиск, фильтры и разделы. Нажатие на раздел прокручивает к нему,
  // а при прокрутке подсвечивается раздел, который сейчас на экране.
  function renderNav() {
    tabsWrap.hidden = MENU.items.length === 0;
    if (!MENU.items.length) return;

    if (state.search.open) {
      $('#tabs').innerHTML = `
        <div class="search-bar">
          ${SEARCH_ICON}
          <input id="searchInput" type="search" value="${esc(state.search.q)}" placeholder="${esc(T('search'))}"
                 autocomplete="off" enterkeyhint="search" aria-label="${esc(T('search'))}">
          <button class="link" type="button" data-search-close>${T('cancel')}</button>
        </div>`;
      return;
    }

    const cats = menuCategories();
    const active = filtersActive();
    if (!cats.some(c => c.id === state.spy)) state.spy = cats.length ? cats[0].id : null;
    $('#tabs').innerHTML = `
      <button class="tab tab-icon" type="button" data-search-open aria-label="${esc(T('search_open'))}">${SEARCH_ICON}</button>
      <button class="tab tab-icon ${active ? 'on' : ''}" type="button" data-filters-open aria-label="${esc(T('filters'))}">
        ${FILTER_ICON}${active ? `<span class="tab-count">${active}</span>` : ''}
      </button>
      ${cats.map(c => `
        <button class="tab ${c.id === state.spy ? 'active' : ''}" type="button" data-cat="${esc(c.id)}"
                ${c.id === state.spy ? 'aria-current="true"' : ''}>
          <span class="tab-emoji">${esc(c.emoji)}</span>${esc(L(c, 'name'))}
        </button>`).join('')}`;
    centerActiveTab(false);
  }

  function centerActiveTab(smooth = true) {
    const tabs = $('#tabs');
    const active = tabs.querySelector('.tab.active');
    if (active) {
      tabs.scrollTo({ left: active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  function setSpy(id) {
    if (!id || state.spy === id) return;
    state.spy = id;
    document.querySelectorAll('#tabs .tab[data-cat]').forEach(b => {
      const on = b.dataset.cat === id;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    centerActiveTab();
  }

  // ───────── поиск: по названию, описанию, составу и разделу, на текущем языке и по-русски

  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

  // «лосось» находит «с лососем», «круассаны» — «круассан»: у длинных слов отбрасываем окончание
  const stem = w => (w.length >= 6 ? w.slice(0, -2) : w.length >= 4 ? w.slice(0, -1) : w);

  function searchItems(q, items) {
    const words = norm(q).split(/\s+/).filter(Boolean).map(stem);
    if (!words.length) return [];
    return items.filter(item => {
      const cat = catOf(item);
      const hay = norm([
        L(item, 'name'), item.name, L(item, 'desc'), item.desc,
        ...(L(item, 'ing') || []), ...item.ing, L(cat, 'name'), cat.name,
        ...itemTags(item).flatMap(t => [L(t, 'name'), t.name]),
      ].filter(Boolean).join(' '));
      return words.every(w => hay.includes(w));
    });
  }

  function renderMenu() {
    const menu = $('#menu');
    menu.hidden = false;

    if (!MENU.items.length) {
      menu.innerHTML = `
        <div class="empty">
          <div class="empty-emoji">📋</div>
          <p>${T('menu_empty')}</p>
          <small>${T('menu_empty_hint')}</small>
        </div>`;
      return;
    }

    const items = visibleItems();
    const emptyFiltered = `
      <div class="empty">
        <div class="empty-emoji">🔍</div>
        <p>${T(filtersActive() ? 'nothing_filtered' : 'nothing_found')}</p>
        ${filtersActive()
          ? `<button class="btn-ghost" type="button" data-filters-reset>${T('reset_filters')}</button>`
          : `<small>${T('nothing_found_hint')}</small>`}
      </div>`;

    if (state.search.open && state.search.q.trim()) {
      const found = searchItems(state.search.q, items);
      menu.innerHTML = found.length ? `
        <div class="group">
          <h2 class="group-title">${T('found', { n: found.length })}</h2>
          <div class="grid">${found.map(card).join('')}</div>
        </div>` : emptyFiltered;
      return;
    }

    const cats = menuCategories(items);
    if (!cats.length) { menu.innerHTML = emptyFiltered; return; }

    menu.innerHTML = cats.map(c => {
      const list = items.filter(i => i.cat === c.id);
      return `
        <div class="group" data-group="${esc(c.id)}">
          <h2 class="group-title">${esc(L(c, 'name'))} <span>${list.length}</span></h2>
          <div class="grid">${list.map(card).join('')}</div>
        </div>`;
    }).join('');
  }

  function renderCartBar() {
    const count = orderCount();
    cartBar.hidden = count === 0;
    if (!count) return;
    cartBar.innerHTML = `
      <span class="cart-bar-left">
        <span class="cart-bar-count">${count}</span>
        ${T('go_to_order')}
      </span>
      <b>${fmt(orderTotal())}</b>`;
  }

  function updateSlots() {
    document.querySelectorAll('.slot').forEach(el => {
      el.innerHTML = control(el.dataset.slot, el.dataset.variant);
    });
  }

  // ───────── подсветка раздела при прокрутке

  let spyLockUntil = 0;   // во время прокрутки по нажатию на раздел подсветку не трогаем
  let spyFrame = 0;

  function updateSpy() {
    if (state.search.open || Date.now() < spyLockUntil) return;
    const groups = [...document.querySelectorAll('#menu .group[data-group]')];
    if (!groups.length) return;
    const line = tabsWrap.getBoundingClientRect().bottom + 24;
    let current = groups[0].dataset.group;
    for (const g of groups) {
      if (g.getBoundingClientRect().top <= line) current = g.dataset.group;
      else break;
    }
    // докрутили до конца страницы — последний раздел, даже если он короткий
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = groups[groups.length - 1].dataset.group;
    }
    setSpy(current);
  }

  window.addEventListener('scroll', () => {
    if (spyFrame) return;
    spyFrame = requestAnimationFrame(() => { spyFrame = 0; updateSpy(); });
  }, { passive: true });

  function scrollToGroup(id) {
    const group = [...document.querySelectorAll('#menu .group[data-group]')].find(g => g.dataset.group === id);
    if (!group) return;
    const top = group.getBoundingClientRect().top + window.scrollY - tabsWrap.offsetHeight - 8;
    setSpy(id);
    spyLockUntil = Date.now() + 900;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  function scrollToMenuTop() {
    const top = $('#menu').getBoundingClientRect().top + window.scrollY - tabsWrap.offsetHeight - 8;
    if (window.scrollY > top) window.scrollTo({ top });
  }

  // ───────── рекомендации: какие разделы к чему подходят — в data/categories.json (pairs_with)

  function recommendationsFor(item) {
    const cats = catOf(item).pairsWith;
    // стабильное «случайное» перемешивание, чтобы у каждой позиции был свой набор
    const hash = s => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
    return MENU.items
      .filter(i => (cats.includes(i.cat) || cats.includes(i.catStyle)) && i.id !== item.id)
      .sort((a, b) => hash(item.id + a.id) - hash(item.id + b.id))
      .slice(0, 8);
  }

  // ───────── окно позиции. Блок создаётся только если для него есть данные (не null)

  function modsBlock(item, sel) {
    if (!item.mods.length) return '';
    return `
      <div class="mods">
        ${item.mods.map(g => `
          <div class="mod-group">
            <div class="mod-head">
              <h3>${esc(L(g, 'name'))}</h3>
              ${g.type === 'multi' && g.max ? `<small>${T('pick_up_to', { n: g.max })}</small>` : ''}
            </div>
            <div class="mod-options" role="${g.type === 'single' ? 'radiogroup' : 'group'}" aria-label="${esc(L(g, 'name'))}">
              ${g.options.map(o => {
                const on = (sel[g.id] || []).includes(o.id);
                return `
                  <button type="button" class="mod ${on ? 'active' : ''}" data-mod="${esc(`${g.id}|${o.id}`)}"
                          role="${g.type === 'single' ? 'radio' : 'checkbox'}" aria-checked="${on}">
                    <span>${esc(L(o, 'name'))}</span>${o.price ? `<small>+${fmt(o.price)}</small>` : ''}
                  </button>`;
              }).join('')}
            </div>
          </div>`).join('')}
      </div>`;
  }

  function productView(entry) {
    const item = BY_ID[entry.id];
    const size = item.sizes[entry.size] ? entry.size : 0;
    const sel = entry.sel || (entry.sel = defaultSel(item));
    const v = item.sizes[size];
    const n = v.nutrition;
    const drink = isDrink(item);
    const recs = recommendationsFor(item);
    const r = x => String(x).replace('.', I18N.lang === 'en' ? '.' : ',');
    const desc = L(item, 'desc');
    const ing = L(item, 'ing') || [];
    const tags = itemTags(item);

    const meta = [
      v.amount && esc(v.amount),
      item.prep !== null && T('min', { n: item.prep }),
      n && n.kcal !== null && T('kcal', { n: r(n.kcal) }),
    ].filter(Boolean);

    const nutri = n ? [[n.kcal, T('kcal_short')], [n.p, T('proteins')], [n.f, T('fats')], [n.c, T('carbs')]]
      .filter(([x]) => x !== null) : [];

    const facts = [
      v.amount && [drink ? T('volume') : T('weight'), esc(v.amount)],
      item.sizes.length > 1 && item.sizes.every(s => s.amount) && [T('variants'), item.sizes.map(s => esc(s.amount)).join(' / ')],
      item.prep !== null && [T('prep_time'), T('min', { n: item.prep })],
    ].filter(Boolean);

    return `
      <div class="pm">
        <div class="pm-hero">${pic(item, 'xl')}</div>

        <div class="pm-body">
          <div class="pm-title-row">
            <h2 class="pm-title">${esc(L(item, 'name'))}</h2>
            ${favButton(item, 'big')}
          </div>
          ${tags.length ? `<div class="pm-tags">${tags.map(t => tagChip(t)).join('')}</div>` : ''}
          ${meta.length ? `<div class="pm-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}

          ${item.sizes.length > 1 ? `
            <div class="sizes" role="radiogroup" aria-label="${esc(T('variants'))}">
              ${item.sizes.map((s, i) => `
                <button type="button" class="size ${i === size ? 'active' : ''}" data-size="${i}" role="radio" aria-checked="${i === size}">
                  <b>${esc(sizeLabel(s, i))}</b><small>${fmt(s.price)}</small>
                </button>`).join('')}
            </div>` : ''}

          ${modsBlock(item, sel)}

          <div class="pm-buy">
            <div class="pm-price"><b>${fmt(unitPrice(item, size, sel))}</b></div>
            ${slot(keyOf(item.id, size, modsKey(item, sel)), 'big')}
          </div>

          ${desc ? `<p class="pm-desc">${esc(desc)}</p>` : ''}

          ${nutri.length ? `
            <h3 class="pm-h">${T('nutrition')} ${v.amount ? `<small>${esc(T('per', { a: v.amount }))}</small>` : ''}</h3>
            <div class="nutri" style="--cols:${nutri.length}">
              ${nutri.map(([x, label]) => `<div><b>${r(x)}</b><small>${label}</small></div>`).join('')}
            </div>` : ''}

          ${ing.length ? `
            <h3 class="pm-h">${T('ingredients')}</h3>
            <div class="chips">${ing.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}

          ${facts.length ? `
            <dl class="facts">
              ${facts.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('')}
            </dl>` : ''}

          ${recs.length ? `
            <h3 class="pm-h rec-title">${drink || catOf(item).kind === 'set' ? T('recs_drink') : T('recs_food')}</h3>
            <div class="rec-row">${recs.map(card).join('')}</div>` : ''}
        </div>
      </div>`;
  }

  // ───────── окно фильтров (черновик в entry.draft, применяется кнопкой «Показать»)

  function filtersView(entry) {
    const d = entry.draft;
    const used = new Set(MENU.items.flatMap(i => i.tags));
    const tags = Object.values(TAGS).filter(t => used.has(t.id));
    const b = priceBounds();
    const value = d.max ?? b.max;
    const count = MENU.items.filter(i => passFilters(i, d)).length;

    return `
      <div class="om">
        <h2 class="om-title">${T('filters')}</h2>

        ${tags.length ? `
          <h3 class="pm-h">${T('filter_tags')}</h3>
          <div class="mod-options">
            ${tags.map(t => {
              const on = d.tags.includes(t.id);
              return `<button type="button" class="mod ${on ? 'active' : ''}" data-filter-tag="${esc(t.id)}" role="checkbox" aria-checked="${on}">
                        <span>${esc(t.emoji)} ${esc(L(t, 'name'))}</span></button>`;
            }).join('')}
          </div>` : ''}

        ${b.max > b.min ? `
          <h3 class="pm-h">${d.max === null ? T('any_price') : T('price_upto', { p: fmt(d.max) })}</h3>
          <input class="range" id="filterPrice" type="range" min="${b.min}" max="${b.max}" step="${b.step}" value="${value}"
                 aria-label="${esc(T('price_upto', { p: '' }))}">
          <div class="range-scale"><span>${fmt(b.min)}</span><span>${fmt(b.max)}</span></div>` : ''}

        <div class="pay-wrap filter-actions">
          <button class="btn-ghost" type="button" data-filters-clear>${T('reset')}</button>
          <button class="btn-primary" type="button" data-filters-apply>${T('show_n', { n: count })}</button>
        </div>
      </div>`;
  }

  // ───────── профиль гостя: имя, избранное, история заказов

  function profileView() {
    const favs = state.favs.map(id => BY_ID[id]).filter(Boolean);
    return `
      <div class="om">
        <h2 class="om-title">${T('profile')}</h2>
        <p class="hint">${T('profile_hint')}</p>

        <label class="field-label" for="guestName">${T('guest_name')}</label>
        <input class="text-input" id="guestName" type="text" maxlength="40" autocomplete="given-name"
               value="${esc(guestName())}" placeholder="${esc(T('guest_name_ph'))}">

        <h3 class="pm-h">${T('favorites')}</h3>
        ${favs.length ? `<div class="rec-row">${favs.map(card).join('')}</div>`
          : `<p class="hint">${T('favorites_empty')}</p>`}

        <h3 class="pm-h">${T('history')}</h3>
        ${state.history.length ? `
          <ul class="history">
            ${state.history.map((h, i) => {
              const names = h.lines.map(l => {
                const { item } = parseKey(l.key);
                return `${item ? L(item, 'name') : l.name}${l.qty > 1 ? ` × ${l.qty}` : ''}`;
              }).join(', ');
              const where = modeLabel(h.dineIn || 'hall', h.table);
              return `
                <li class="history-item">
                  <div class="history-head">
                    <b>${T('order_no', { n: h.no })}</b>
                    <small>${esc(I18N.formatDateTime(new Date(h.at)))}</small>
                  </div>
                  <p>${esc(names)}</p>
                  ${h.demo ? `<small class="demo-label">${T('demo_saved')}</small>
                    ${h.address ? `<p>${esc(h.address)}</p>` : ''}` : ''}
                  <div class="history-foot">
                    <small>${where} · <b>${fmt(h.total)}</b></small>
                    <button class="btn-ghost small" type="button" data-repeat="${i}">↻ ${T('repeat')}</button>
                  </div>
                </li>`;
            }).join('')}
          </ul>` : `<p class="hint">${T('history_empty')}</p>`}
      </div>`;
  }

  // ───────── проверка API Gemma (персонал)

  function apiView() {
    const a = state.api;
    const full = Boolean(CONFIG.gemmaHealthUrl);
    return `
      <div class="om">
        <h2 class="om-title">${T('api_title')}</h2>
        <p class="hint">${T(full ? 'api_hint' : 'api_conn_hint', { host: esc(new URL(CONFIG.gemmaUrl).host) })}</p>

        <div class="api-status ${a.status}">
          <span class="api-dot ${a.status}"></span>
          <div>
            <b>${esc(a.status === 'checking' ? T('api_checking') : a.message || T('api_never'))}</b>
            ${a.at ? `<small>${esc(T('api_last', { t: I18N.formatDateTime(new Date(a.at)) }))}${a.model ? ` · ${esc(a.model)}` : ''}</small>` : ''}
          </div>
        </div>

        <div class="pay-wrap">
          <button class="btn-primary" type="button" data-api-run ${a.status === 'checking' ? 'disabled' : ''}>${T('api_check')}</button>
        </div>
      </div>`;
  }

  // Без посредника: есть ли связь с сервером Gemma. Ключ не нужен — сервер отвечает и без него
  // («нет доступа» = сервер на связи). Модель и ключ так не проверить — для этого посредник.
  async function checkConnection(signal) {
    const started = performance.now();
    const res = await fetch(`${CONFIG.gemmaUrl}/models`, { signal, cache: 'no-store' });
    const seconds = ((performance.now() - started) / 1000).toFixed(1).replace('.', ',');
    if (res.status >= 500) return { ok: false, message: T('api_server', { code: res.status }) };
    return { ok: true, message: T('api_conn_ok', { s: seconds }) };
  }

  // Полная проверка через посредника: он сам обращается к Gemma с ключом и отвечает только «работает / нет»
  async function checkApi(silent = false) {
    state.api = { ...state.api, status: 'checking' };
    refreshHeader();
    renderModal(false);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_SEC * 1000);
    let ok = false;
    let message;
    let model = null;
    try {
      if (!CONFIG.gemmaHealthUrl) {
        ({ ok, message } = await checkConnection(ctrl.signal));
      } else {
        const res = await fetch(CONFIG.gemmaHealthUrl, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw Object.assign(new Error('health'), { proxy: res.status });
        const h = await res.json();
        model = typeof h.model === 'string' ? h.model : null;
        const seconds = (Number(h.ms) / 1000 || 0).toFixed(1).replace('.', ',');
        if (h.ok) { ok = true; message = T('api_ok', { s: seconds }); }
        else if (h.error === 'no_key') message = T('api_proxy_no_key');
        else if (h.error === 'timeout') message = T('api_timeout', { s: 20 });
        else if (h.error === 'network') message = T('api_offline');
        else if (h.status === 401 || h.status === 403) message = T('api_bad_key', { code: h.status });
        else if (h.status === 404) message = T('api_no_model', { m: model || 'gemma' });
        else if (h.status === 429) message = T('api_limit');
        else message = T('api_server', { code: h.status });
      }
    } catch (e) {
      message = e.name === 'AbortError' ? T('api_timeout', { s: API_TIMEOUT_SEC })
        : e.proxy ? T('api_proxy_error', { code: e.proxy })
        : CONFIG.gemmaHealthUrl ? T('api_proxy_offline') : T('api_offline');
    } finally {
      clearTimeout(timer);
    }

    state.api = { status: ok ? 'ok' : 'fail', message, model, at: Date.now() };
    refreshHeader();
    if (topModal() && topModal().type === 'api') renderModal(false);
    else if (!silent) toast(message);
  }

  // в режиме персонала индикатор проверяет связь сам при открытии страницы
  let autoChecked = false;
  function autoCheckApi() {
    if (state.staff && !autoChecked) { autoChecked = true; checkApi(true); }
  }

  // ───────── окно заказа

  function estimateMinutes() {
    const lines = orderLines();
    if (!lines.length) return 0;
    const maxPrep = Math.max(...lines.map(l => l.item.prepEstimate));
    const qty = lines.reduce((s, l) => s + l.qty, 0);
    const raw = maxPrep + Math.min(15, (qty - 1) * 2);
    return Math.max(5, Math.ceil(raw / 5) * 5);
  }

  const clock = mins => new Date(Date.now() + mins * 60000)
    .toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });

  function timeOptions() {
    const est = checkoutQuote().minutes;
    const opts = [{ id: 'asap', title: T('asap'), sub: `${T('min', { n: est })} · ${T('at', { t: clock(est) })}` }];
    [30, 60, 90, 120].forEach(m => {
      if (m >= est + 5) opts.push({ id: String(m), title: T(`in_${m}`), sub: T('at', { t: clock(m) }) });
    });
    return opts;
  }

  function checkoutField(id, label, value, type = 'text', autocomplete = 'off', max = 160) {
    const error = state.checkoutErrors[id];
    return `<label class="field-label" for="${id}">${T(label)}</label>
      <input class="text-input" id="${id}" type="${type}" maxlength="${max}" autocomplete="${autocomplete}"
        value="${esc(value)}" ${error ? `aria-invalid="true" aria-describedby="${id}Error"` : ''}>
      ${error ? `<p class="field-error" id="${id}Error" role="alert">${T(error)}</p>` : ''}`;
  }

  function fulfillmentView(quote) {
    if (!isRemoteOrder()) return '';
    const pickup = state.dineIn === 'pickup';
    const address = pickupSettings().address || MENU.cafe.address;
    const delivery = deliverySettings();
    return `<section class="fulfillment-panel" aria-label="${esc(T(state.dineIn))}">
      <p class="demo-note">${T('demo_notice')}</p>
      ${pickup ? `<b>${T('pickup_point')}</b><p>${esc(address || T('pickup_address_pending'))}</p>
        ${MENU.cafe.hours ? `<small>${esc(MENU.cafe.hours)}</small>` : ''}` :
        `${checkoutField('deliveryAddress', 'delivery_address', state.contact.address, 'text', 'street-address')}
        ${checkoutField('deliveryDetails', 'delivery_details', state.contact.details)}
        <p class="hint">${T('delivery_terms', { fee: fmt(delivery.fee), min: fmt(delivery.minOrder) })}
          ${delivery.freeFrom !== null ? T('delivery_free_from', { p: fmt(delivery.freeFrom) }) : ''}</p>
        ${quote.remaining > 0 ? `<p class="field-error" role="status">${T('delivery_remaining', { p: fmt(quote.remaining) })}</p>` : ''}`}
      ${checkoutField('orderPhone', 'contact_phone', state.contact.phone, 'tel', 'tel', 30)}
    </section>`;
  }

  function receiptView({ order }) {
    return `<div class="om receipt">
      <div class="receipt-icon" aria-hidden="true">${order.dineIn === 'pickup' ? '🛍️' : '🛵'}</div>
      <h2 class="om-title">${T('demo_order_no', { n: order.no })}</h2>
      <p class="demo-note">${T('demo_confirmation')}</p>
      <h3>${modeLabel(order.dineIn)}</h3>
      <p>${esc(order.address || T('pickup_address_pending'))}</p>
      ${order.details ? `<p>${esc(order.details)}</p>` : ''}
      <p>${esc(order.name)} · ${esc(order.phone)}</p>
      <p>${T(order.dineIn === 'pickup' ? 'pickup_when' : 'delivery_when')} ${esc(order.timeLabel)}</p>
      <div class="summary">
        <div><span>${T('items_subtotal')}</span><span>${fmt(order.subtotal)}</span></div>
        ${order.dineIn === 'delivery' ? `<div><span>${T('delivery_fee')}</span><span>${fmt(order.deliveryFee)}</span></div>` : ''}
        <div class="total"><span>${T('total')}</span><span>${fmt(order.total)}</span></div>
      </div>
      <button class="btn-primary pay" type="button" data-close>${T('back_to_menu')}</button>
    </div>`;
  }

  function orderView() {
    const lines = orderLines();
    if (!lines.length) {
      return `
        <div class="om">
          <h2 class="om-title">${T('your_order')}</h2>
          <div class="empty">
            <div class="empty-emoji">🧾</div>
            <p>${T('order_empty')}</p>
            <small>${T('order_empty_hint')}</small>
            <button class="btn-primary" type="button" data-close>${T('back_to_menu')}</button>
          </div>
        </div>`;
    }

    if (!orderModes().includes(state.dineIn)) state.dineIn = 'hall';
    const quote = checkoutQuote();
    const opts = timeOptions();
    if (!opts.some(o => o.id === state.when)) state.when = 'asap';
    const count = orderCount();

    return `
      <div class="om">
        <div class="om-head">
          <h2 class="om-title">${T('your_order')}</h2>
          <button class="link" type="button" data-clear>${T('clear')}</button>
        </div>

        <ul class="lines">
          ${lines.map(l => {
            const amount = l.item.sizes[l.size].amount;
            const mods = modsLabel(l.item, l.sel);
            return `
              <li class="line">
                <div class="line-pic" data-open-key="${esc(l.key)}">${pic(l.item)}</div>
                <div class="line-info" data-open-key="${esc(l.key)}">
                  <b>${esc(L(l.item, 'name'))}</b>
                  ${amount ? `<small>${esc(amount)}</small>` : ''}
                  ${mods ? `<small class="line-mods">${esc(mods)}</small>` : ''}
                  <small>${fmt(l.unit)} × ${l.qty}</small>
                </div>
                <div class="line-right">
                  <b>${fmt(l.unit * l.qty)}</b>
                  ${control(l.key, 'mini')}
                </div>
              </li>`;
          }).join('')}
        </ul>

        <h3 class="pm-h">${T('where')}</h3>
        <div class="segmented">
          ${orderModes().map(mode => `<button type="button" class="${state.dineIn === mode ? 'active' : ''}"
            data-dine="${mode}" aria-pressed="${state.dineIn === mode}">${esc(modeLabel(mode, state.table))}</button>`).join('')}
        </div>
        ${fulfillmentView(quote)}

        <h3 class="pm-h">${T(state.dineIn === 'pickup' ? 'pickup_when' : state.dineIn === 'delivery' ? 'delivery_when' : 'when')}</h3>
        <div class="times">
          ${opts.map(o => `
            <button type="button" class="time ${o.id === state.when ? 'active' : ''}" data-when="${o.id}">
              <b>${o.title}</b><small>${o.sub}</small>
            </button>`).join('')}
        </div>
        <p class="hint">${T(isRemoteOrder() ? 'demo_time_hint' : 'time_hint')}</p>

        ${checkoutField('orderName', 'for_name', guestName(), 'text', 'given-name', 40)}

        <h3 class="pm-h">${T('comment')}</h3>
        <textarea class="comment" id="orderComment" rows="2" maxlength="300" placeholder="${esc(T('comment_ph'))}">${esc(state.comment)}</textarea>

        <div class="summary">
          <div><span>${I18N.items(count)}</span><span>${fmt(orderTotal())}</span></div>
          ${state.dineIn === 'delivery' ? `<div><span>${T('delivery_fee')}</span><span>${fmt(quote.fee)}</span></div>` : ''}
          <div class="total"><span>${T('total')}</span><span>${fmt(quote.total)}</span></div>
        </div>

        <div class="pay-wrap">
          <button class="btn-primary pay" type="button" data-pay ${quote.remaining > 0 ? 'disabled' : ''}>${T(isRemoteOrder() ? 'demo_submit' : 'pay')} · ${fmt(quote.total)}</button>
        </div>
      </div>`;
  }

  // ───────── модальные окна (со стеком и кнопкой «Назад» браузера)

  const VIEWS = { product: productView, order: orderView, filters: filtersView, profile: profileView, api: apiView, receipt: receiptView };
  const viewLabel = top => (top.type === 'product' ? L(BY_ID[top.id], 'name')
    : T({ order: 'your_order', filters: 'filters', profile: 'profile', api: 'api_title', receipt: 'demo_saved' }[top.type]));

  function renderModal(resetScroll) {
    const top = state.stack[state.stack.length - 1];
    if (!top) {
      overlay.classList.remove('open');
      document.body.classList.remove('locked');
      setTimeout(() => { if (!state.stack.length) { overlay.hidden = true; sheet.innerHTML = ''; } }, 250);
      return;
    }

    const scroller = sheet.querySelector('.sheet-scroll');
    const prevScroll = scroller && !resetScroll ? scroller.scrollTop : 0;
    const canBack = state.stack.length > 1;

    sheet.className = `sheet ${top.type === 'product' ? 'product' : 'order'}`;
    sheet.setAttribute('aria-label', viewLabel(top));
    sheet.innerHTML = `
      <div class="sheet-controls">
        ${canBack ? `<button class="round-btn" type="button" data-back aria-label="${esc(T('back'))}">
          <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>` : '<span></span>'}
        <button class="round-btn" type="button" data-close aria-label="${esc(T('close'))}">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="sheet-scroll">${VIEWS[top.type](top)}</div>`;

    sheet.querySelector('.sheet-scroll').scrollTop = prevScroll;
    if (resetScroll) {
      sheet.classList.remove('swap');
      void sheet.offsetWidth;
      sheet.classList.add('swap');
    }

    if (overlay.hidden) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('open'));
    } else {
      overlay.classList.add('open');
    }
    document.body.classList.add('locked');
  }

  function pushModal(entry) {
    if (entry.type === 'product' && !BY_ID[entry.id]) return;
    state.stack.push(entry);
    history.pushState({ depth: state.stack.length }, '');
    renderModal(true);
  }

  function closeAll() {
    if (state.stack.length) history.go(-state.stack.length);
  }

  window.addEventListener('popstate', e => {
    const depth = (e.state && e.state.depth) || 0;
    if (depth < state.stack.length) {
      state.stack.length = depth;
      renderModal(true);
    }
  });

  const topModal = () => state.stack[state.stack.length - 1];

  // ───────── изменение заказа

  function changeQty(key, delta) {
    const q = Math.max(0, Math.min(999, qtyOf(key) + delta));
    if (q) state.order[key] = q; else delete state.order[key];
    saveOrder();
    updateSlots();
    renderCartBar();
    if (delta > 0) {
      cartBar.classList.remove('bump');
      void cartBar.offsetWidth;
      cartBar.classList.add('bump');
    }
    const top = topModal();
    if (top && top.type === 'order') renderModal(false);
  }

  function toggleMod(entry, gid, oid) {
    const item = BY_ID[entry.id];
    const g = item.mods.find(x => x.id === gid);
    if (!g) return;
    const cur = entry.sel[gid] || [];
    if (g.type === 'single') {
      entry.sel[gid] = [oid];
    } else if (cur.includes(oid)) {
      entry.sel[gid] = cur.filter(x => x !== oid);
    } else {
      // больше максимума — убираем самый ранний выбор
      entry.sel[gid] = [...cur, oid].slice(g.max ? -g.max : 0);
    }
  }

  function toggleFav(id) {
    state.favs = state.favs.includes(id) ? state.favs.filter(x => x !== id) : [...state.favs, id];
    writeStore(storeKey('favs'), state.favs);
    const on = state.favs.includes(id);
    document.querySelectorAll('.fav-btn').forEach(b => {
      if (b.dataset.fav !== id) return;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', T(on ? 'fav_remove' : 'fav_add'));
    });
  }

  // «Оплатить»: настоящей оплаты пока нет — заказ сохраняется в историю, корзина очищается
  function placeOrder() {
    const lines = orderLines();
    if (!lines.length) return;
    if (!orderModes().includes(state.dineIn)) { state.dineIn = 'hall'; renderModal(false); return; }
    const quote = checkoutQuote();
    if (quote.remaining > 0) { renderModal(false); return; }
    state.checkoutErrors = {};
    if (isRemoteOrder()) {
      if (!guestName().trim()) state.checkoutErrors.orderName = 'name_required';
      if (!/^[+\d\s().-]+$/.test(state.contact.phone) || !/^\d{10,15}$/.test(state.contact.phone.replace(/\D/g, '')))
        state.checkoutErrors.orderPhone = 'phone_invalid';
      if (state.dineIn === 'delivery' && !DeliveryModule.validAddress(state.contact.address))
        state.checkoutErrors.deliveryAddress = 'address_required';
      if (Object.keys(state.checkoutErrors).length) {
        renderModal(false);
        document.getElementById(Object.keys(state.checkoutErrors)[0]).focus();
        return;
      }
    }
    const opts = timeOptions();
    const selectedTime = opts.find(o => o.id === state.when) || opts[0];
    state.when = selectedTime.id;
    const no = (state.history[0] ? state.history[0].no : 0) + 1;
    const order = {
      no,
      at: Date.now(),
      lines: lines.map(l => ({ key: l.key, qty: l.qty, name: l.item.name, unit: l.unit })),
      total: quote.total,
      subtotal: orderTotal(),
      deliveryFee: quote.fee,
      demo: isRemoteOrder(),
      phone: isRemoteOrder() ? state.contact.phone.trim() : null,
      address: state.dineIn === 'delivery' ? state.contact.address.trim() : state.dineIn === 'pickup'
        ? pickupSettings().address || MENU.cafe.address : null,
      details: state.dineIn === 'delivery' ? state.contact.details.trim() : null,
      timeLabel: selectedTime.sub,
      dineIn: state.dineIn,
      table: state.dineIn === 'hall' ? state.table : null,
      when: state.when,
      name: guestName() || null,
      comment: state.comment || null,
    };
    state.history.unshift(order);
    state.history = state.history.slice(0, 30);
    writeStore(storeKey('history'), state.history);

    state.order = {};
    state.comment = '';
    saveOrder();
    saveComment();
    updateSlots();
    renderCartBar();
    if (order.demo) {
      state.stack[state.stack.length - 1] = { type: 'receipt', order };
      renderModal(true);
    } else {
      closeAll();
      toast(T('order_placed', { n: no }));
    }
  }

  function repeatOrder(index) {
    const h = state.history[index];
    if (!h) return;
    let added = 0;
    let missing = false;
    for (const l of h.lines) {
      const { item, size } = parseKey(l.key);
      if (!item || !item.sizes[size]) { missing = true; continue; }
      state.order[l.key] = Math.min(999, qtyOf(l.key) + l.qty);
      added += l.qty;
    }
    saveOrder();
    updateSlots();
    renderCartBar();
    toast(missing ? `${T('repeat_added', { n: added })}. ${T('repeat_missing')}` : T('repeat_added', { n: added }));
    if (added) pushModal({ type: 'order' });
  }

  // ───────── язык

  function closeLangMenu() {
    const menu = document.querySelector('.lang-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      document.querySelector('[data-lang-toggle]').setAttribute('aria-expanded', 'false');
    }
  }

  function setLang(id) {
    I18N.set(id);
    if (MENU) {
      money = makeMoney(MENU.currency);
      renderMenuPage();
      if (state.stack.length) renderModal(false);
    } else if (state.picker) {
      showPicker();
    } else if (state.error) {
      renderError(state.error);
    }
  }

  // ───────── события

  document.addEventListener('click', e => {
    if (!e.target.closest('.lang')) closeLangMenu();

    const langT = e.target.closest('[data-lang-toggle],[data-lang]');
    if (langT) {
      if (langT.dataset.lang) { closeLangMenu(); setLang(langT.dataset.lang); return; }
      const menu = langT.parentElement.querySelector('.lang-menu');
      menu.hidden = !menu.hidden;
      langT.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }

    // окно и проверка API работают и на экране выбора кофейни, где меню не загружено
    if (e.target === overlay) { closeAll(); return; }
    const m = e.target.closest('[data-close],[data-back],[data-api-open],[data-api-run]');
    if (m) {
      if (m.dataset.apiOpen !== undefined) pushModal({ type: 'api' });
      else if (m.dataset.apiRun !== undefined) checkApi();
      else if (m.dataset.back !== undefined) history.back();
      else closeAll();
      return;
    }

    if (!MENU) return;

    const t = e.target.closest([
      '[data-fav]', '[data-add]', '[data-inc]', '[data-dec]', '[data-open]', '[data-open-key]', '[data-cat]',
      '[data-size]', '[data-mod]', '[data-order]', '[data-clear]', '[data-dine]',
      '[data-when]', '[data-search-open]', '[data-search-close]', '[data-filters-open]', '[data-filter-tag]',
      '[data-filters-apply]', '[data-filters-clear]', '[data-filters-reset]', '[data-profile]', '[data-pay]', '[data-repeat]',
    ].join(','));
    if (!t) return;
    const d = t.dataset;

    if (d.fav) toggleFav(d.fav);
    else if (d.add) changeQty(d.add, 1);
    else if (d.inc) changeQty(d.inc, 1);
    else if (d.dec) changeQty(d.dec, -1);
    else if (d.open) pushModal({ type: 'product', id: d.open, size: 0 });
    else if (d.openKey) {
      const { item, size, sel } = parseKey(d.openKey);
      if (item) pushModal({ type: 'product', id: item.id, size, sel });
    }
    else if (d.cat) scrollToGroup(d.cat);
    else if (d.size !== undefined) {
      topModal().size = Number(d.size);
      renderModal(false);
    }
    else if (d.mod) {
      const [gid, oid] = d.mod.split('|');
      toggleMod(topModal(), gid, oid);
      renderModal(false);
    }
    else if (d.searchOpen !== undefined) {
      state.search.open = true;
      renderNav();
      scrollToMenuTop();
      $('#searchInput').focus();
    }
    else if (d.searchClose !== undefined) {
      state.search = { open: false, q: '' };
      renderNav();
      renderMenu();
      updateSpy();
    }
    else if (d.filtersOpen !== undefined) {
      pushModal({ type: 'filters', draft: { tags: [...state.filters.tags], max: state.filters.max } });
    }
    else if (d.filterTag) {
      const draft = topModal().draft;
      draft.tags = draft.tags.includes(d.filterTag) ? draft.tags.filter(x => x !== d.filterTag) : [...draft.tags, d.filterTag];
      renderModal(false);
    }
    else if (d.filtersClear !== undefined) {
      topModal().draft = { tags: [], max: null };
      renderModal(false);
    }
    else if (d.filtersApply !== undefined || d.filtersReset !== undefined) {
      state.filters = d.filtersApply !== undefined ? topModal().draft : { tags: [], max: null };
      if (d.filtersApply !== undefined) closeAll();
      renderNav();
      renderMenu();
      scrollToMenuTop();
      updateSpy();
    }
    else if (d.profile !== undefined) pushModal({ type: 'profile' });
    else if (d.pay !== undefined) placeOrder();
    else if (d.repeat !== undefined) repeatOrder(Number(d.repeat));
    else if (d.order !== undefined) pushModal({ type: 'order' });
    else if (d.clear !== undefined) {
      state.order = {};
      state.comment = '';
      saveOrder();
      saveComment();
      updateSlots();
      renderCartBar();
      renderModal(false);
    }
    else if (d.dine && orderModes().includes(d.dine)) {
      state.dineIn = d.dine; state.checkoutErrors = {}; renderModal(false);
    }
    else if (d.when) { state.when = d.when; renderModal(false); }
  });

  document.addEventListener('input', e => {
    const id = e.target.id;
    if (state.checkoutErrors[id]) {
      delete state.checkoutErrors[id];
      e.target.removeAttribute('aria-invalid');
      e.target.removeAttribute('aria-describedby');
      document.getElementById(`${id}Error`)?.remove();
    }
    if (id === 'searchInput') {
      state.search.q = e.target.value;
      renderMenu();
    } else if (id === 'orderComment') {
      state.comment = e.target.value;
      saveComment();
    } else if (id === 'guestName' || id === 'orderName') {
      writeStore('guest:name', e.target.value.trim());
    } else if (['orderPhone', 'deliveryAddress', 'deliveryDetails'].includes(id)) {
      state.contact[{ orderPhone: 'phone', deliveryAddress: 'address', deliveryDetails: 'details' }[id]] = e.target.value;
    } else if (id === 'filterPrice') {
      const b = priceBounds();
      const v = Number(e.target.value);
      topModal().draft.max = v >= b.max ? null : v;
      // перерисовываем только подписи, чтобы ползунок не терял фокус
      const draft = topModal().draft;
      sheet.querySelector('.om .pm-h:last-of-type').textContent =
        draft.max === null ? T('any_price') : T('price_upto', { p: fmt(draft.max) });
      sheet.querySelector('[data-filters-apply]').textContent =
        T('show_n', { n: MENU.items.filter(i => passFilters(i, draft)).length });
    }
  });

  // карточки открываются и с клавиатуры
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeLangMenu();
      if (state.stack.length) { closeAll(); return; }
      if (state.search.open) { $('[data-search-close]').click(); return; }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open][tabindex]')) {
      e.preventDefault();
      e.target.click();
    }
    // Enter в поиске — убрать клавиатуру на телефоне, чтобы были видны результаты
    if (e.key === 'Enter' && e.target.id === 'searchInput') e.target.blur();  });

  // тень у ленты разделов, когда она прилипла к верху
  new IntersectionObserver(([en]) => tabsWrap.classList.toggle('stuck', en.intersectionRatio < 1),
    { threshold: [1], rootMargin: '-1px 0px 0px 0px' }).observe(tabsWrap);

  // ───────── выбор кофейни и ошибки

  function showScreen(html) {
    $('#today').hidden = true;
    tabsWrap.hidden = true;
    $('#menu').hidden = true;
    const screen = $('#screen');
    screen.hidden = false;
    screen.innerHTML = html;
  }

  async function renderPicker(cafes) {
    // подгружаем меню, чтобы показать число позиций
    const menus = await Promise.allSettled(cafes.map(c => API.getMenu(c, STYLES)));
    state.picker = { cafes, menus };
    showPicker();
    autoCheckApi();
  }

  function showPicker() {
    const { cafes, menus } = state.picker;
    renderHeader(null, false);
    if (!cafes.length) {
      showScreen(`
        <div class="empty">
          <p>${T('no_cafes')}</p>
          <small>${T('no_cafes_hint')}</small>
        </div>`);
      return;
    }
    showScreen(`
      <h2 class="screen-title">${T('choose_cafe')}</h2>
      <div class="cafes">
        ${cafes.map((c, i) => {
          const res = menus[i];
          const m = res.status === 'fulfilled' ? res.value : null;
          const where = [c.city, c.address].filter(Boolean).join(', ');
          const count = m ? m.items.length : 0;
          const status = !m ? T('menu_error') : count ? I18N.items(count) : T('menu_empty');
          return `
            <a class="cafe-card ${m ? '' : 'broken'}" href="?cafe=${encodeURIComponent(c.id)}">
              ${logo(c.logo, c.name, 'cafe-logo')}
              <span class="cafe-info">
                <b>${esc(c.name)}</b>
                ${where ? `<small>${esc(where)}</small>` : ''}
                <small class="cafe-status">${esc(status)}</small>
              </span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
            </a>`;
        }).join('')}
      </div>`);
  }

  function renderError(err) {
    if (state.error !== err) console.error(err);
    state.error = err;
    BRAND = BRAND || { name: 'Secretbox', logo: null }; // реестр кофеен не загрузился — шапка всё равно нужна (язык)
    renderHeader(null, false);
    showScreen(`
      <div class="empty error">
        <div class="empty-emoji">⚠️</div>
        <p>${T('load_error')}</p>
        <small>${esc(err.message)}</small>
        ${err.url ? `<code>${esc(err.url)}</code>` : ''}
      </div>`);
  }

  // ───────── запуск

  let canSwitchCafe = false;

  function renderMenuPage() {
    renderHeader(MENU.cafe, canSwitchCafe);
    renderToday();
    renderNav();
    renderMenu();
    renderCartBar();
    updateSpy();
  }

  function startMenu() {
    CATS = Object.fromEntries(MENU.categories.map(c => [c.id, c]));
    BY_ID = Object.fromEntries(MENU.items.map(i => [i.id, i]));
    money = makeMoney(MENU.currency);
    applyTheme(MENU.cafe);

    state.order = loadOrder();
    const comment = readStore(storeKey('comment'), '');
    state.comment = typeof comment === 'string' ? comment : '';
    const favs = readStore(storeKey('favs'), []);
    state.favs = Array.isArray(favs) ? favs.filter(id => typeof id === 'string') : [];
    const hist = readStore(storeKey('history'), []);
    state.history = Array.isArray(hist) ? hist.filter(h => h && Array.isArray(h.lines) && Number.isFinite(h.no)) : [];

    // номер стола из QR-кода: ?table=5 — сразу «в зале»
    const table = (new URLSearchParams(location.search).get('table') || '').trim();
    if (/^[\w-]{1,10}$/.test(table)) {
      state.table = table;
      state.dineIn = 'hall';
    }

    renderMenuPage();
    autoCheckApi();
  }

  async function init() {
    // если страницу обновили с открытым окном — сбрасываем состояние истории
    if (history.state && history.state.depth) history.replaceState(null, '');

    // режим персонала (на любой странице): ?staff=1 включает кнопку «Проверить API» в этом браузере, ?staff=0 выключает
    const staffParam = new URLSearchParams(location.search).get('staff');
    if (staffParam === '1' || staffParam === '0') writeStore('staff', staffParam === '1');
    state.staff = readStore('staff', false) === true;
    // прошлая версия кнопки хранила ключ в браузере — стираем, если он там остался
    try { localStorage.removeItem('staff:gemma_key'); } catch { /* приватный режим */ }

    const loading = $('#menu .loading');
    if (loading) loading.textContent = T('loading');

    try {
      const [styles, { brand, cafes }, tags, config] = await Promise.all([
        API.getStyles(), API.getCafes(), API.getTags(), API.getConfig(),
      ]);
      CONFIG = config;
      STYLES = styles;
      BRAND = brand;
      TAGS = Object.fromEntries(tags.map(t => [t.id, t]));

      const wanted = new URLSearchParams(location.search).get('cafe');
      const cafe = cafes.find(c => c.id === wanted) || (cafes.length === 1 ? cafes[0] : null);
      if (!cafe) return renderPicker(cafes);

      MENU = await API.getMenu(cafe, styles);
      canSwitchCafe = cafes.length > 1;
      startMenu();
    } catch (err) {
      renderError(err);
    }
  }

  init();
})();
