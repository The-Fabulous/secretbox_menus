// Слой доступа к данным.
// Сейчас данные читаются из JSON-файлов. При переходе на базу данных достаточно
// поменять адреса в ENDPOINTS на адреса API (например, /api/cafes/:id/menu),
// которые отдают JSON того же формата, — остальной код сайта менять не нужно.

const API = (() => {
  'use strict';

  const ENDPOINTS = {
    styles: () => 'data/categories.json',   // будущее: /api/category-styles
    cafes:  () => 'tabs/index.json',        // список папок вкладок
    tags:   () => 'data/tags.json',         // будущее: /api/tags
    menu:   cafe => cafe.file,              // будущее: `/api/cafes/${cafe.id}/menu`
  };

  class DataError extends Error {
    constructor(message, url) { super(message); this.url = url; }
  }

  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-cache' });
    } catch {
      throw new DataError('Не удалось загрузить данные. Сайт нужно открывать через локальный сервер (start.cmd), а не двойным кликом по index.html.', url);
    }
    if (!res.ok) throw new DataError(`Файл не найден (${res.status})`, url);
    const text = await res.text();
    if (!text.trim()) return null; // пустой файл — пустое меню
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new DataError(`Ошибка в JSON: ${e.message}`, url);
    }
  }

  // null, '', [] — «нет данных»: такие блоки на сайте не показываются
  const present = v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  const num = v => (present(v) && Number.isFinite(Number(v)) ? Number(v) : null);
  const str = v => (present(v) ? String(v) : null);

  // Переводы из JSON ("i18n": { "kz": { "name": ..., "description": ..., "ingredients": [...] } })
  // приводятся к тем же именам полей, что и у позиции после нормализации (name, desc, ing).
  const I18N_FIELDS = { name: 'name', description: 'desc', ingredients: 'ing' };
  function normalizeI18n(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [lang, fields] of Object.entries(raw)) {
      if (!fields || typeof fields !== 'object') continue;
      out[lang] = {};
      for (const [from, to] of Object.entries(I18N_FIELDS)) {
        const v = fields[from];
        if (Array.isArray(v) ? v.length : present(v)) out[lang][to] = Array.isArray(v) ? v.map(String) : String(v);
      }
    }
    return out;
  }
  // перевод раздела кофейни дополняет перевод из общих стилей
  const mergeI18n = (base = {}, extra = {}) => {
    const out = { ...base };
    for (const [lang, fields] of Object.entries(extra)) out[lang] = { ...(base[lang] || {}), ...fields };
    return out;
  };

  // ───────── общие стили разделов (цвет, тип, рекомендации)

  const FALLBACK_STYLE = {
    id: 'other', name: 'Другое', emoji: '🍽️', kind: 'other',
    colors: ['#f1ebe4', '#c9b6a3'], pairsWith: [], prep: 5,
  };

  async function getStyles() {
    const raw = await getJSON(ENDPOINTS.styles());
    const styles = {};
    ((raw && raw.categories) || []).forEach(c => {
      styles[c.id] = {
        id: String(c.id),
        name: c.name || c.id,
        emoji: c.emoji || FALLBACK_STYLE.emoji,
        kind: c.kind || 'other',
        colors: Array.isArray(c.colors) && c.colors.length === 2 ? c.colors : FALLBACK_STYLE.colors,
        pairsWith: Array.isArray(c.pairs_with) ? c.pairs_with : [],
        prep: num(c.default_prep_min) || FALLBACK_STYLE.prep,
        i18n: normalizeI18n(c.i18n),
      };
    });
    if (!styles.other) styles.other = FALLBACK_STYLE;
    return styles;
  }

  // ───────── реестр кофеен

  async function getCafes() {
    const raw = (await getJSON(ENDPOINTS.cafes())) || {};
    const brand = raw.brand || {};
    const entries = await Promise.all((Array.isArray(raw.tabs) ? raw.tabs : []).map(async folder => {
      const base = `tabs/${encodeURIComponent(folder)}/`;
      const c = await getJSON(`${base}cafe.json`);
      return c && { ...c, file: `${base}menu.json`, logo: assetURL(c.logo, `${base}cafe.json`) };
    }));
    const cafes = entries
      .filter(c => c && c.id && c.file)
      .map(c => ({
        id: String(c.id),
        file: c.file,
        name: str(c.name) || String(c.id),
        logo: str(c.logo),
        address: str(c.address),
        city: str(c.city),
        hours: str(c.hours),
        currency: str(c.currency) || 'KZT',
        // фирменный цвет кофейни: кнопки, акценты, выбранные варианты
        accent: c.theme && /^#[0-9a-f]{6}$/i.test(c.theme.accent) ? c.theme.accent : null,
      }));
    return { brand: { name: str(brand.name) || 'Меню', logo: str(brand.logo) }, cafes };
  }

  // Пути внутри вкладки относительны её JSON: папку можно переносить целиком.
  function assetURL(path, jsonFile) {
    return present(path) ? new URL(String(path), new URL(jsonFile, document.baseURI)).href : null;
  }

  // ───────── метки позиций (Хит, Новинка, Веган…). Файла нет — меток нет, сайт работает и без них

  async function getTags() {
    let raw;
    try {
      raw = await getJSON(ENDPOINTS.tags());
    } catch (e) {
      console.warn('Метки не загружены:', e.message);
      return [];
    }
    return ((raw && raw.tags) || [])
      .filter(t => t && present(t.id) && present(t.name))
      .map(t => ({
        id: String(t.id),
        name: String(t.name),
        emoji: str(t.emoji) || '',
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : null,
        i18n: normalizeI18n(t.i18n),
      }));
  }

  // ───────── меню кофейни

  function normalizeCategory(raw, styles, index) {
    const style = styles[raw.id] || styles.other;
    return {
      ...style,
      id: String(raw.id),
      name: str(raw.name) || style.name,
      emoji: str(raw.icon) || style.emoji,
      order: num(raw.order) ?? 1000 + index,
      i18n: mergeI18n(style.i18n, normalizeI18n(raw.i18n)),
    };
  }

  // Группы добавок: молоко (выбор одного), сироп / доп. шот (можно несколько).
  // id попадают в ключ заказа («milk.oat,syrup.vanilla»), поэтому только буквы, цифры, _ и -.
  const SAFE_ID = /^[\w-]+$/;
  const safeId = (v, what) => {
    if (present(v) && SAFE_ID.test(String(v))) return true;
    console.warn(`${what} пропущен: id «${v}» может содержать только латинские буквы, цифры, _ и -`);
    return false;
  };

  function normalizeModifierGroups(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter(g => g && safeId(g.id, 'Группа добавок') && Array.isArray(g.options))
      .map(g => {
        const options = g.options
          .filter(o => o && safeId(o.id, `Вариант добавки в «${g.id}»`) && present(o.name))
          .map(o => ({
            id: String(o.id),
            name: String(o.name),
            price: num(o.price) || 0,
            default: o.default === true,
            i18n: normalizeI18n(o.i18n),
          }));
        const type = g.type === 'multi' ? 'multi' : 'single';
        // в группе «один из» всегда есть вариант по умолчанию
        if (type === 'single' && options.length && !options.some(o => o.default)) options[0].default = true;
        return {
          id: String(g.id),
          name: str(g.name) || String(g.id),
          type,
          max: type === 'multi' ? num(g.max) : 1,
          appliesTo: Array.isArray(g.applies_to) ? g.applies_to.map(String) : [],
          options,
          i18n: normalizeI18n(g.i18n),
        };
      })
      .filter(g => g.options.length);
  }

  function normalizeNutrition(n) {
    if (!n || typeof n !== 'object') return null;
    const res = { kcal: num(n.calories), p: num(n.proteins), f: num(n.fats), c: num(n.carbs) };
    return Object.values(res).some(v => v !== null) ? res : null;
  }

  function normalizeItem(raw, index, cats, styles, usedIds) {
    if (!raw || typeof raw !== 'object' || !present(raw.name)) {
      console.warn(`Позиция #${index + 1} пропущена: нет названия`, raw);
      return null;
    }

    // раздел, которого нет в списке кофейни, — добавляем из общих стилей
    let cat = cats.find(c => c.id === raw.category_id);
    if (!cat) {
      const id = styles[raw.category_id] ? raw.category_id : 'other';
      cat = cats.find(c => c.id === id) || normalizeCategory({ id }, styles, cats.length);
      if (!cats.includes(cat)) cats.push(cat);
    }

    const sizes = (Array.isArray(raw.variants) ? raw.variants : [])
      .filter(v => v && num(v.price) !== null)
      .map((v, i) => ({
        id: str(v.variant_id) || String(i),
        label: str(v.measure) || `Вариант ${i + 1}`,
        amount: str(v.measure),
        price: num(v.price),
        nutrition: normalizeNutrition(v.nutrition),
      }));
    if (!sizes.length) {
      console.warn(`Позиция «${raw.name}» пропущена: нет вариантов с ценой`, raw);
      return null;
    }

    // id нужен для заказа; если его нет — берём название
    let id = str(raw.id) || String(raw.name);
    while (usedIds.has(id)) id += '_';
    usedIds.add(id);

    const prep = num(raw.prep_time_min);
    return {
      id,
      cat: cat.id,
      name: String(raw.name),
      desc: str(raw.description),
      image: str(raw.image_url),
      // эмодзи позиции (показывается, если нет фото); без букв и цифр, иначе — значок раздела
      icon: str(raw.icon) && raw.icon.length <= 8 && !/[\p{L}\p{N}\s]/u.test(raw.icon) ? raw.icon : null,
      ing: Array.isArray(raw.ingredients) ? raw.ingredients.filter(present).map(String) : [],
      prep,                                    // null — не показываем
      prepEstimate: prep ?? cat.prep,          // для расчёта времени заказа
      special: raw.is_special === true,
      sizes,
      price: sizes[0].price,
      i18n: normalizeI18n(raw.i18n),
      tags: Array.isArray(raw.tags) ? raw.tags.filter(present).map(String) : [],
      // null — добавки по разделу (applies_to); [] — без добавок; ['milk'] — только эти группы
      modIds: Array.isArray(raw.modifier_group_ids) ? raw.modifier_group_ids.map(String) : null,
    };
  }

  async function getMenu(cafe, styles) {
    const raw = (await getJSON(ENDPOINTS.menu(cafe))) || {};

    const cats = (Array.isArray(raw.categories) ? raw.categories : [])
      .filter(c => c && present(c.id))
      .map((c, i) => normalizeCategory(c, styles, i));

    const usedIds = new Set();
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((it, i) => normalizeItem(it, i, cats, styles, usedIds))
      .filter(Boolean);
    items.forEach(item => { item.image = assetURL(item.image, cafe.file); });

    const groups = normalizeModifierGroups(raw.modifier_groups);
    items.forEach(item => {
      item.mods = item.modIds
        ? groups.filter(g => item.modIds.includes(g.id))
        : groups.filter(g => g.appliesTo.includes(item.cat));
      delete item.modIds;
    });

    cats.sort((a, b) => a.order - b.order);
    return { cafe, currency: cafe.currency, categories: cats, items };
  }

  // ───────── настройки сайта (data/config.json). Нет файла — значения по умолчанию

  const DEFAULT_GEMMA_URL = 'https://llm.alem.ai/v1';

  async function getConfig() {
    try {
      const raw = (await getJSON('data/config.json')) || {};
      const https = v => (str(v) && /^https:\/\//.test(v) ? String(v).replace(/\/+$/, '') : null);
      return { gemmaHealthUrl: https(raw.gemma_health_url), gemmaUrl: https(raw.gemma_url) || DEFAULT_GEMMA_URL };
    } catch {
      return { gemmaHealthUrl: null, gemmaUrl: DEFAULT_GEMMA_URL };
    }
  }

  return { getStyles, getCafes, getTags, getMenu, getConfig, DataError };
})();
