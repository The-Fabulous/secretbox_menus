// Языки интерфейса: RU / KZ / EN.
// Тексты интерфейса — в словаре ниже. Названия и описания позиций берутся из JSON меню:
// поле "i18n": { "kz": { "name": "...", "description": "..." }, "en": { ... } }. Нет перевода — показывается русский.

const I18N = (() => {
  'use strict';

  // locale — для цен, времени и дат. У казахского в браузерах часто нет своих правил форматирования
  // (дата выходит как «M10 25, Sun»), поэтому числа и время — как в русском («2 190 ₸», «15:35»),
  // а дата собирается вручную (formatDate).
  const LANGS = [
    { id: 'ru', label: 'RU', name: 'Русский',  locale: 'ru-RU' },
    { id: 'kz', label: 'KZ', name: 'Қазақша',  locale: 'ru-RU' },
    { id: 'en', label: 'EN', name: 'English',  locale: 'en-GB' },
  ];

  const KZ_MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];
  const KZ_DAYS = ['жексенбі', 'дүйсенбі', 'сейсенбі', 'сәрсенбі', 'бейсенбі', 'жұма', 'сенбі'];

  const DICT = {
    ru: {
      today: 'Сегодня в меню',
      loading: 'Загружаем меню…',
      special_drink: 'Напиток дня', special_sweet: 'Десерт дня', special_set: 'Комбо дня', special_food: 'Блюдо дня',
      from_price: 'от {p}',
      add: 'В заказ',
      add_to_order: 'Добавить в заказ',
      in_order: '{n} в заказе',
      remove_one: 'Убрать одну', add_one: 'Добавить ещё',
      go_to_order: 'Перейти к заказу',
      open_map: 'Открыть на карте',
      switch_cafe: 'Выбрать другую кофейню',
      profile: 'Профиль',
      language: 'Язык',
      back: 'Назад', close: 'Закрыть',
      search: 'Поиск по меню', search_open: 'Поиск', cancel: 'Отмена',
      found: 'Найдено: {n}',
      nothing_found: 'Ничего не нашлось',
      nothing_found_hint: 'Попробуйте другое слово',
      menu_empty: 'Меню пока пустое', menu_empty_hint: 'Скоро здесь появятся напитки и блюда',
      min: '~{n} мин', kcal: '{n} ккал',
      variant: 'Вариант {n}',
      nutrition: 'Пищевая ценность', per: 'на {a}',
      kcal_short: 'ккал', proteins: 'белки, г', fats: 'жиры, г', carbs: 'углеводы, г',
      ingredients: 'Состав',
      volume: 'Объём', weight: 'Вес', variants: 'Варианты', prep_time: 'Время приготовления',
      pick_up_to: 'до {n}',
      recs_drink: 'К этому напитку возьмите', recs_food: 'К этому подойдёт',
      your_order: 'Ваш заказ', clear: 'Очистить',
      order_empty: 'В заказе пока пусто', order_empty_hint: 'Добавьте что-нибудь вкусное из меню', back_to_menu: 'Вернуться в меню',
      where: 'Где будете есть?', hall: '🪑 В зале', togo: '🛍️ С собой',
      when: 'Когда приготовить?', asap: 'Побыстрее', at: 'к {t}',
      in_30: 'Через 30 мин', in_60: 'Через 1 час', in_90: 'Через 1,5 часа', in_120: 'Через 2 часа',
      time_hint: 'Время рассчитано по самой долгой позиции в заказе и загрузке кухни.',
      comment: 'Комментарий к заказу', comment_ph: 'Например: без сахара, погорячее',
      total: 'Итого', pay: 'Оплатить',
      choose_cafe: 'Выберите кофейню',
      no_cafes: 'Кофеен пока нет', no_cafes_hint: 'Добавьте кофейню в tabs/index.json',
      menu_error: 'Ошибка в данных меню',
      load_error: 'Не получилось загрузить меню',
      table: 'Стол {n}', hall_table: '🪑 В зале · стол {n}',
      filters: 'Фильтры', filter_tags: 'Метки', price_upto: 'Цена до {p}', any_price: 'Любая цена',
      reset: 'Сбросить', show_n: 'Показать: {n}',
      nothing_filtered: 'Под фильтры ничего не подходит', reset_filters: 'Сбросить фильтры',
      profile_hint: 'Данные хранятся только в этом браузере',
      guest_name: 'Как к вам обращаться?', guest_name_ph: 'Имя для заказа', for_name: 'На имя',
      favorites: 'Избранное', favorites_empty: 'Нажмите ♡ на позиции, чтобы сохранить её здесь',
      fav_add: 'В избранное', fav_remove: 'Убрать из избранного',
      history: 'История заказов', history_empty: 'Здесь появятся ваши заказы',
      repeat: 'Повторить', order_no: 'Заказ № {n}', order_placed: 'Заказ № {n} оформлен',
      repeat_added: 'Добавлено в заказ: {n}', repeat_missing: 'Некоторых позиций больше нет в меню',
      // проверка Gemma — только для персонала (?staff=1), поэтому только по-русски
      api_title: 'Проверка API Gemma', api_chip: 'Проверить API',
      api_hint: 'Сайт спрашивает сервер проверки Secretbox, а тот — Gemma. Ключ хранится только у сервера проверки и сюда не передаётся. Результат обновляется не чаще раза в минуту.',
      api_conn_hint: 'Проверяется связь с сервером Gemma ({host}) — ключ для этого не нужен и не передаётся. Чтобы проверять ещё и работу модели с ключом, разверните сервер проверки gemma-health (инструкция в gemma-health/README.md).',
      api_conn_ok: '✓ Сервер Gemma на связи — ответ за {s} с',
      api_check: 'Проверить', api_checking: 'Проверяем…',
      api_ok: '✓ Gemma исправна — ответ за {s} с',
      api_proxy_no_key: '✗ У сервера проверки не задан ключ Gemma (секрет GEMMA_API_KEY)',
      api_proxy_error: '✗ Сервер проверки ответил ошибкой {code}', api_proxy_offline: '✗ Сервер проверки недоступен',
      api_bad_key: '✗ Неверный ключ (сервер ответил {code})', api_no_model: '✗ Модель «{m}» не найдена на сервере',
      api_limit: '✗ Превышен лимит запросов, попробуйте позже', api_server: '✗ Сервер Gemma неисправен (код {code})',
      api_offline: '✗ Нет связи с сервером Gemma', api_timeout: '✗ Сервер не ответил за {s} с',
      api_never: 'Ещё не проверяли', api_last: 'Последняя проверка: {t}',
    },
    kz: {
      today: 'Бүгінгі мәзір',
      loading: 'Мәзір жүктелуде…',
      special_drink: 'Күн сусыны', special_sweet: 'Күн десерті', special_set: 'Күн комбосы', special_food: 'Күн тағамы',
      from_price: '{p} бастап',
      add: 'Тапсырысқа',
      add_to_order: 'Тапсырысқа қосу',
      in_order: 'Тапсырыста: {n}',
      remove_one: 'Біреуін алып тастау', add_one: 'Тағы қосу',
      go_to_order: 'Тапсырысқа өту',
      open_map: 'Картадан ашу',
      switch_cafe: 'Басқа кофехананы таңдау',
      profile: 'Профиль',
      language: 'Тіл',
      back: 'Артқа', close: 'Жабу',
      search: 'Мәзірден іздеу', search_open: 'Іздеу', cancel: 'Болдырмау',
      found: 'Табылды: {n}',
      nothing_found: 'Ештеңе табылмады',
      nothing_found_hint: 'Басқа сөзбен іздеп көріңіз',
      menu_empty: 'Мәзір әзірге бос', menu_empty_hint: 'Жақында мұнда сусындар мен тағамдар пайда болады',
      min: '~{n} мин', kcal: '{n} ккал',
      variant: '{n}-нұсқа',
      nutrition: 'Тағамдық құндылығы', per: '{a} үшін',
      kcal_short: 'ккал', proteins: 'ақуыз, г', fats: 'май, г', carbs: 'көмірсу, г',
      ingredients: 'Құрамы',
      volume: 'Көлемі', weight: 'Салмағы', variants: 'Нұсқалар', prep_time: 'Дайындалу уақыты',
      pick_up_to: '{n}-ге дейін',
      recs_drink: 'Бұл сусынға қосып алыңыз', recs_food: 'Бұған жарасады',
      your_order: 'Сіздің тапсырысыңыз', clear: 'Тазалау',
      order_empty: 'Тапсырыс әлі бос', order_empty_hint: 'Мәзірден дәмді бірдеңе қосыңыз', back_to_menu: 'Мәзірге оралу',
      where: 'Қайда жейсіз?', hall: '🪑 Залда', togo: '🛍️ Алып кету',
      when: 'Қашан дайындау керек?', asap: 'Тезірек', at: 'шамамен {t}',
      in_30: '30 минуттан кейін', in_60: '1 сағаттан кейін', in_90: '1,5 сағаттан кейін', in_120: '2 сағаттан кейін',
      time_hint: 'Уақыт тапсырыстағы ең ұзақ дайындалатын позиция мен ас үйдің жүктемесі бойынша есептелді.',
      comment: 'Тапсырысқа түсініктеме', comment_ph: 'Мысалы: қантсыз, ыстығырақ',
      total: 'Барлығы', pay: 'Төлеу',
      choose_cafe: 'Кофехананы таңдаңыз',
      no_cafes: 'Әзірге кофеханалар жоқ', no_cafes_hint: 'Кофехананы tabs/index.json файлына қосыңыз',
      menu_error: 'Мәзір деректерінде қате',
      load_error: 'Мәзірді жүктеу мүмкін болмады',
      table: '{n}-үстел', hall_table: '🪑 Залда · {n}-үстел',
      filters: 'Сүзгілер', filter_tags: 'Белгілер', price_upto: 'Бағасы {p} дейін', any_price: 'Кез келген баға',
      reset: 'Тазалау', show_n: 'Көрсету: {n}',
      nothing_filtered: 'Сүзгілерге сай ештеңе жоқ', reset_filters: 'Сүзгілерді тазалау',
      profile_hint: 'Деректер тек осы браузерде сақталады',
      guest_name: 'Сізге қалай жүгінейік?', guest_name_ph: 'Тапсырыс үшін есім', for_name: 'Есім',
      favorites: 'Таңдаулылар', favorites_empty: 'Позицияны осында сақтау үшін ♡ басыңыз',
      fav_add: 'Таңдаулыларға қосу', fav_remove: 'Таңдаулылардан алып тастау',
      history: 'Тапсырыстар тарихы', history_empty: 'Мұнда сіздің тапсырыстарыңыз пайда болады',
      repeat: 'Қайталау', order_no: '№ {n} тапсырыс', order_placed: '№ {n} тапсырыс рәсімделді',
      repeat_added: 'Тапсырысқа қосылды: {n}', repeat_missing: 'Кейбір позициялар енді мәзірде жоқ',
    },
    en: {
      today: "Today's specials",
      loading: 'Loading the menu…',
      special_drink: 'Drink of the day', special_sweet: 'Dessert of the day', special_set: 'Combo of the day', special_food: 'Dish of the day',
      from_price: 'from {p}',
      add: 'Add',
      add_to_order: 'Add to order',
      in_order: '{n} in order',
      remove_one: 'Remove one', add_one: 'Add one more',
      go_to_order: 'View order',
      open_map: 'Open in maps',
      switch_cafe: 'Choose another café',
      profile: 'Profile',
      language: 'Language',
      back: 'Back', close: 'Close',
      search: 'Search the menu', search_open: 'Search', cancel: 'Cancel',
      found: 'Found: {n}',
      nothing_found: 'Nothing found',
      nothing_found_hint: 'Try another word',
      menu_empty: 'The menu is empty for now', menu_empty_hint: 'Drinks and dishes will appear here soon',
      min: '~{n} min', kcal: '{n} kcal',
      variant: 'Option {n}',
      nutrition: 'Nutrition facts', per: 'per {a}',
      kcal_short: 'kcal', proteins: 'protein, g', fats: 'fat, g', carbs: 'carbs, g',
      ingredients: 'Ingredients',
      volume: 'Volume', weight: 'Weight', variants: 'Options', prep_time: 'Preparation time',
      pick_up_to: 'up to {n}',
      recs_drink: 'Goes well with this drink', recs_food: 'Goes well with this',
      your_order: 'Your order', clear: 'Clear',
      order_empty: 'Your order is empty', order_empty_hint: 'Add something tasty from the menu', back_to_menu: 'Back to menu',
      where: 'Eat in or take away?', hall: '🪑 Eat in', togo: '🛍️ Take away',
      when: 'When should it be ready?', asap: 'As soon as possible', at: 'by {t}',
      in_30: 'In 30 min', in_60: 'In 1 hour', in_90: 'In 1.5 hours', in_120: 'In 2 hours',
      time_hint: 'Estimated from the longest item in your order and the kitchen load.',
      comment: 'Order comment', comment_ph: 'E.g. no sugar, extra hot',
      total: 'Total', pay: 'Pay',
      choose_cafe: 'Choose a café',
      no_cafes: 'No cafés yet', no_cafes_hint: 'Add a café to tabs/index.json',
      menu_error: 'Menu data error',
      load_error: 'Could not load the menu',
      table: 'Table {n}', hall_table: '🪑 Eat in · table {n}',
      filters: 'Filters', filter_tags: 'Tags', price_upto: 'Up to {p}', any_price: 'Any price',
      reset: 'Reset', show_n: 'Show {n}',
      nothing_filtered: 'Nothing matches the filters', reset_filters: 'Reset filters',
      profile_hint: 'Stored only in this browser',
      guest_name: 'What should we call you?', guest_name_ph: 'Name for the order', for_name: 'Name',
      favorites: 'Favourites', favorites_empty: 'Tap ♡ on an item to save it here',
      fav_add: 'Add to favourites', fav_remove: 'Remove from favourites',
      history: 'Order history', history_empty: 'Your orders will appear here',
      repeat: 'Repeat', order_no: 'Order #{n}', order_placed: 'Order #{n} placed',
      repeat_added: 'Added to order: {n}', repeat_missing: 'Some items are no longer on the menu',
    },
  };

  // «N позиций» с правильным склонением
  const ITEMS = {
    ru: n => {
      const m10 = n % 10, m100 = n % 100;
      const w = m10 === 1 && m100 !== 11 ? 'позиция' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? 'позиции' : 'позиций';
      return `${n} ${w}`;
    },
    kz: n => `${n} позиция`,
    en: n => `${n} ${n === 1 ? 'item' : 'items'}`,
  };

  const STORAGE_KEY = 'lang';
  const detect = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (DICT[saved]) return saved;
    } catch { /* приватный режим */ }
    const nav = (navigator.language || 'ru').toLowerCase();
    if (nav.startsWith('kk')) return 'kz';
    if (nav.startsWith('en')) return 'en';
    return 'ru';
  };

  let lang = detect();

  return {
    LANGS,
    get lang() { return lang; },
    get locale() { return LANGS.find(l => l.id === lang).locale; },
    set(next) {
      if (!DICT[next]) return;
      lang = next;
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* приватный режим */ }
      document.documentElement.lang = next === 'kz' ? 'kk' : next;
    },
    // текст интерфейса: t('found', { n: 3 })
    t(key, vars = {}) {
      const s = (DICT[lang] && DICT[lang][key]) ?? DICT.ru[key] ?? key;
      return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    },
    items: n => ITEMS[lang](n),
    // «Воскресенье, 25 октября» / «25 қазан, жексенбі» / «Sunday 25 October»
    formatDate(d) {
      if (lang === 'kz') return `${d.getDate()} ${KZ_MONTHS[d.getMonth()]}, ${KZ_DAYS[d.getDay()]}`;
      const s = d.toLocaleDateString(this.locale, { weekday: 'long', day: 'numeric', month: 'long' });
      return s.charAt(0).toUpperCase() + s.slice(1); // «Воскресенье, 25 октября» — заглавная только первая
    },
    // для истории заказов: «25 октября, 14:30»
    formatDateTime(d) {
      const time = d.toLocaleTimeString(this.locale, { hour: '2-digit', minute: '2-digit' });
      const date = lang === 'kz' ? `${d.getDate()} ${KZ_MONTHS[d.getMonth()]}`
        : d.toLocaleDateString(this.locale, { day: 'numeric', month: 'long' });
      return `${date}, ${time}`;
    },
    // поле данных с переводом: L(item, 'name')
    L(obj, field) {
      if (!obj) return '';
      const tr = obj.i18n && obj.i18n[lang] && obj.i18n[lang][field];
      return tr != null && tr !== '' ? tr : obj[field];
    },
  };
})();

document.documentElement.lang = I18N.lang === 'kz' ? 'kk' : I18N.lang;
