"""Распознаёт фото меню через Gemma и собирает целую вкладку в tabs/<id>/.

Папка результата: cafe.json, menu.json, images/, logo.*, raw/ (ответы для проверки).
Каждое фото отправляется в модель отдельно, позиции со всех фото объединяются в одно меню,
а ответ модели проверяется и приводится к формату сайта: цены — числами, неизвестное — null,
id — латиницей, пути к фото — images/<id>.jpg относительно menu.json.

Запуск (из папки menu_parser):
  pip install -r requirements.txt
  python driver.py ../venues/ayu_menu
  python driver.py ../venues/ayu_menu --out output/tabs/ayu_menu

Ключ API — в файле .env рядом со скриптом (OPENAI_API_KEY=...).
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SITE = HERE.parent / 'coffee-menu'
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}

# ───────── настройки

def load_env(path):
    """Простой разбор .env: KEY=VALUE, # — комментарий. Переменные окружения важнее файла."""
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_json(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, json.JSONDecodeError):
        return fallback


# ───────── фото → фрагменты для модели
#
# Длинный скриншот меню (например, 1268×21000) нельзя просто уменьшить: текст станет нечитаемым.
# Поэтому ширина ограничивается max_width, а по высоте картинка режется на фрагменты с перекрытием,
# чтобы карточка, разрезанная краем одного фрагмента, целиком попала в соседний.

TILE_HEIGHT = 2000
TILE_OVERLAP = 700


def to_data_url(im):
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=90)
    return f'data:image/jpeg;base64,{base64.b64encode(buf.getvalue()).decode()}'


def image_tiles(path, max_width):
    """Фрагменты фото сверху вниз: [(картинка PIL или None, data URL)]. Картинка нужна, чтобы вырезать фото позиций."""
    try:
        from PIL import Image, ImageOps
    except ImportError:  # без Pillow отправляем как есть, без вырезания фото
        mime = mimetypes.guess_type(path.name)[0] or 'image/jpeg'
        return [(None, f'data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}')]

    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')  # фото с телефона бывают повёрнуты
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    w, h = im.size
    tile_h = max(TILE_HEIGHT, round(w * 1.2))
    if h <= tile_h * 1.15:
        return [(im, to_data_url(im))]

    step = tile_h - TILE_OVERLAP
    tops = list(range(0, h - tile_h, step)) + [h - tile_h]  # последний фрагмент — ровно до низа
    return [(t, to_data_url(t)) for t in (im.crop((0, top, w, top + tile_h)) for top in tops)]


# ───────── фото позиций: модель указывает, где фото, скрипт уточняет рамку и вырезает

PHOTO_PROMPT = """На изображении — меню кофейни. Найди фотографии позиций (фото напитка или блюда).
Не считай фотографией: значок загрузки, пустую или тёмную карточку, иконки, кнопки, логотип, фон,
а также бледное (полупрозрачное) фото с надписью поверх — «Скоро», «Нет в наличии», «Закончилось».
Если название позиции под фото не видно целиком (обрезано краем изображения) — пропусти это фото,
не угадывай название.
Для каждой фотографии укажи название позиции, к которой она относится (как написано на карточке),
и рамку самой фотографии в координатах 0..1000 относительно ширины и высоты изображения: [x1, y1, x2, y2],
где (x1, y1) — левый верхний угол, (x2, y2) — правый нижний; x — по горизонтали, y — по вертикали.
Ответ — только JSON: {"photos": [{"name": "...", "box": [x1, y1, x2, y2]}]}. Если фотографий нет — {"photos": []}."""


def ask_photos(client, model, data_url):
    """Где на фрагменте фото позиций. Ошибка здесь не мешает меню — просто будут эмодзи."""
    try:
        data, _ = call_model(client, model, [{'role': 'user', 'content': [
            {'type': 'text', 'text': PHOTO_PROMPT},
            {'type': 'image_url', 'image_url': {'url': data_url}},
        ]}], max_tokens=3000)
        photos = data.get('photos') or [] if isinstance(data, dict) else []
        return [p for p in photos if isinstance(p, dict) and text_or_null(p.get('name'))
                and isinstance(p.get('box'), list) and len(p['box']) == 4]
    except Exception as e:
        print(f'    (фото позиций не найдены — будут эмодзи: {str(e)[:150]})')
        return []


CARD_SIZE = 600      # фото позиции на сайте — квадрат CARD_SIZE×CARD_SIZE
CARD_MARGIN = 0.07   # поле вокруг предмета, доля стороны


def _content_mask(region):
    """«Не фон»: отличие от цвета фона ИЛИ резкий перепад яркости (контур).
    По контуру видны и предметы цвета фона — белая пачка кофе на белом фоне."""
    import numpy as np
    border = np.concatenate([region[0], region[-1], region[:, 0], region[:, -1]])
    bg = np.median(border, axis=0)
    color = np.abs(region - bg).max(axis=2) > 28
    gray = region.mean(axis=2)
    edges = np.zeros(gray.shape, dtype=bool)
    edges[:, 1:] |= np.abs(np.diff(gray, axis=1)) > 24
    edges[1:, :] |= np.abs(np.diff(gray, axis=0)) > 24
    return color | edges, bg


def _span_profile(mask):
    """Для каждой строки — доля ширины от первого до последнего пикселя содержимого.
    У белой пачки закрашены только края, но размах — во всю ширину, поэтому пачка не теряется.
    Одиночные выбросы по краям (шум JPEG) не учитываются."""
    import numpy as np
    w = mask.shape[1]
    out = np.zeros(mask.shape[0])
    for y, row in enumerate(mask):
        idx = np.flatnonzero(row)
        if len(idx) >= 3:
            out[y] = (idx[-2] - idx[1] + 1) / w
    return out


def is_faded(img):
    """Бледная заглушка «Скоро» / «Нет в наличии» (полупрозрачное фото с надписью поверх).
    Признаки: почти нет средних тонов; либо их мало, а сам предмет очень светлый и выцветший.
    Светлая чашка с какао или белая пачка кофе сюда не попадают: у них есть насыщенные цвета или средние тона."""
    import numpy as np
    a = np.asarray(img.convert('RGB'), dtype=float)
    lum = a.mean(axis=2)
    obj = lum < 235
    if not obj.any():
        return True
    mid = ((lum > 60) & (lum < 200)).mean()
    sat = (a.max(axis=2) - a.min(axis=2)) / (a.max(axis=2) + 1)
    return mid < 0.06 or (mid < 0.13 and lum[obj].mean() > 195 and sat[obj].mean() < 0.12)


def to_card(img):
    """Квадратная плашка CARD_SIZE×CARD_SIZE: предмет по центру с полями, фон дополнен цветом фона фото.
    Карточка на сайте квадратная — так ничего не обрезается и все позиции выглядят одинаково."""
    import numpy as np
    from PIL import Image
    a = np.asarray(img.convert('RGB'))
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = tuple(int(v) for v in np.median(border, axis=0))
    inner = int(CARD_SIZE * (1 - 2 * CARD_MARGIN))
    scale = inner / max(img.width, img.height)
    fitted = img.convert('RGB').resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    card = Image.new('RGB', (CARD_SIZE, CARD_SIZE), bg)
    # края фото плавно растворяются в фоне плашки: фон у исходного фото редко идеально ровный,
    # и без этого на квадрате проступал бы прямоугольник исходного кадра
    fade = max(4, int(min(fitted.size) * 0.06))
    ramp_x = np.minimum(np.arange(fitted.width), np.arange(fitted.width)[::-1]) / fade
    ramp_y = np.minimum(np.arange(fitted.height), np.arange(fitted.height)[::-1]) / fade
    alpha = np.clip(np.minimum.outer(ramp_y, ramp_x), 0, 1)
    mask = Image.fromarray((alpha * 255).astype('uint8'), 'L')
    card.paste(fitted, ((CARD_SIZE - fitted.width) // 2, (CARD_SIZE - fitted.height) // 2), mask)
    return card


def crop_photo(tile, box):
    """Вырезает фото позиции по примерной рамке модели и возвращает квадратную плашку для сайта.
    По горизонтали модель попадает в карточку точно, а по вертикали часто промахивается, поэтому область
    расширяется в основном вверх-вниз. Фото — самая «тяжёлая» сплошная полоса строк с содержимым:
    подпись и цена отделены от него полосой чистого фона и в кадр не попадают.
    None — если фото не нашлось (пустая карточка, значок загрузки), это бледная заглушка «Скоро»
    или фото обрезано краем фрагмента. Тогда у позиции будет эмодзи."""
    img = None
    for candidate in _box_orders(box):
        img = _locate_photo(tile, candidate)
        if img is not None:
            break
    if img is None or is_faded(img):
        return None
    return to_card(img)


def _box_orders(box):
    """Рамка в порядке [x1, y1, x2, y2], а если в нём она невозможна (правый край левее левого) —
    другие порядки, которые встречаются у моделей: [x1, y1, y2, x2] и [y1, x1, y2, x2]."""
    try:
        a, b, c, d = (float(v) for v in box)
    except (TypeError, ValueError):
        return []
    orders = [(a, b, c, d), (a, b, d, c), (b, a, d, c)]
    return [o for o in orders if o[2] > o[0] and o[3] > o[1]]


def _locate_photo(tile, box):
    import numpy as np

    W, H = tile.size
    try:
        x1, y1, x2, y2 = (min(1000.0, max(0.0, float(v))) for v in box)
    except (TypeError, ValueError):
        return None
    if x2 - x1 < 20 or y2 - y1 < 20:
        return None
    bx1, by1, bx2, by2 = x1 * W / 1000, y1 * H / 1000, x2 * W / 1000, y2 * H / 1000
    bw, bh = bx2 - bx1, by2 - by1
    ey1, ey2 = int(max(0, by1 - 0.30 * bh)), int(min(H, by2 + 0.30 * bh))

    # если фото упирается в боковой край области — рамка модели была узкой, пробуем шире
    for expand in (0.04, 0.30, 0.80):
        ex1, ex2 = int(max(0, bx1 - expand * bw)), int(min(W, bx2 + expand * bw))
        region = np.asarray(tile.crop((ex1, ey1, ex2, ey2)), dtype=np.int16)
        if region.shape[0] < 60 or region.shape[1] < 60:
            return None

        mask, _ = _content_mask(region)
        # строки считаем только в колонках рамки модели — соседние карточки не мешают
        core = mask[:, int(bx1 - ex1):max(int(bx1 - ex1) + 1, int(bx2 - ex1))]
        rows = _span_profile(core)
        if rows.max() < 0.25:
            return None                                   # почти пусто — значок загрузки или пустая карточка
        # фото от подписи и цены отделяет полоса чистого фона
        runs = _runs(rows, 0.15, max_gap=6)
        if not runs:
            return None
        r0, r1 = max(runs, key=lambda r: rows[r[0]:r[1]].sum())  # самая «тяжёлая» полоса — фото
        if r1 - r0 < 50:
            return None
        # фото упирается в верх или низ фрагмента — оно обрезано, целиком будет на соседнем
        if (r0 == 0 and ey1 == 0) or (r1 >= region.shape[0] - 1 and ey2 == H):
            return None

        # по горизонтали — сплошная колонка содержимого, в которой центр рамки модели
        cols = _span_profile(mask[r0:r1].T)
        col_runs = _runs(cols, 0.15, max_gap=6)
        if not col_runs:
            return None
        center = (bx1 + bx2) / 2 - ex1
        c0, c1 = min(col_runs, key=lambda r: 0 if r[0] <= center < r[1] else min(abs(r[0] - center), abs(r[1] - center)))
        if (c0 == 0 and ex1 > 0) or (c1 >= region.shape[1] and ex2 < W):
            continue                                      # обрезано сбоку — пробуем область шире
        if c1 - c0 < 50:
            return None
        # строки уточняем по найденной колонке — без соседей сверху и снизу
        rows2 = _span_profile(mask[:, c0:c1])
        runs2 = [r for r in _runs(rows2, 0.15, max_gap=6) if r[0] < r1 and r[1] > r0]
        if runs2:
            r0, r1 = min(r[0] for r in runs2), max(r[1] for r in runs2)
        # под фото должно поместиться название: если фото у нижнего края фрагмента, подпись обрезана
        # и модель могла приписать фото чужое название — берём это фото с соседнего фрагмента
        if H - (ey1 + r1) < max(40, 0.3 * (r1 - r0)):
            return None
        return tile.crop((ex1 + c0, ey1 + r0, ex1 + c1, ey1 + r1))
    return None  # и в широкой области фото обрезано сбоку — лучше эмодзи, чем половина фото


def _runs(values, threshold, max_gap):
    """Сплошные отрезки, где values > threshold (разрывы до max_gap склеиваются): [(начало, конец)]."""
    runs, start, gap = [], None, 0
    for i, v in enumerate(values):
        if v > threshold:
            start = i if start is None else start
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max_gap:
                runs.append((start, i - gap + 1))
                start, gap = None, 0
    if start is not None:
        runs.append((start, len(values) - gap))
    return runs


# ───────── запрос к модели

# Модель отвечает короткими ключами — меньше текста: быстрее, меньше упирается в лимит токенов и реже обрывается.
# Скрипт переводит их обратно в формат сайта (expand_keys); ответы с полными ключами тоже понимает.
KEY_MAPPING = {
    'cats': 'categories', 'mods': 'modifier_groups', 'itms': 'items',
    'cid': 'category_id', 'n': 'name', 'ic': 'icon', 'desc': 'description', 'ing': 'ingredients',
    'vars': 'variants', 'm': 'measure', 'p': 'price',
    'nut': 'nutrition', 'cal': 'calories', 'pro': 'proteins', 'fat': 'fats', 'carb': 'carbs',
    't': 'type', 'app': 'applies_to', 'opts': 'options', 'def': 'default',
}
SHORT_KEYS = {v: k for k, v in KEY_MAPPING.items()}
# это скрипт заполняет сам — модели писать не нужно
NOT_FOR_MODEL = {'image_url', 'prep_time_min', 'is_special', 'variant_id', 'order'}


def _rename_keys(obj, mapping, drop=()):
    if isinstance(obj, dict):
        return {mapping.get(k, k): _rename_keys(v, mapping, drop) for k, v in obj.items() if k not in drop}
    if isinstance(obj, list):
        return [_rename_keys(x, mapping, drop) for x in obj]
    return obj


def expand_keys(data):
    return _rename_keys(data, KEY_MAPPING)


def shorten_keys(data):
    return _rename_keys(data, SHORT_KEYS, NOT_FOR_MODEL)


PROMPT_EXAMPLE = {
    'categories': [{'id': 'coffee', 'name': 'Кофе'}],
    'modifier_groups': [],
    'items': [
        {'category_id': 'coffee', 'name': 'Капучино', 'icon': '☕', 'description': None, 'ingredients': None,
         'variants': [{'measure': '250 мл', 'price': 1190, 'nutrition': None},
                      {'measure': '350 мл', 'price': 1390, 'nutrition': None}]},
        {'category_id': 'coffee', 'name': 'Раф лавандовый', 'icon': '☕',
         'description': 'Эспрессо, сливки и лавандовый сироп', 'ingredients': None,
         'variants': [{'measure': None, 'price': 1590,
                       'nutrition': {'calories': 280, 'proteins': None, 'fats': None, 'carbs': None}}]},
    ],
}


def build_prompt(etalon, categories):
    cats = '\n'.join(f'  - {c["id"]} — {c["name"]}' for c in categories if c['id'] != 'other')
    template = shorten_keys(etalon)
    for item in template.get('itms', []):
        item.pop('id', None)  # id позиции скрипт строит из названия
    return f"""На фото — страница меню кофейни. Перепиши ВСЕ позиции с фото в JSON строго по шаблону.

Ключи в шаблоне сокращены: cats — разделы, itms — позиции, mods — группы добавок, cid — id раздела,
n — название, ic — эмодзи, desc — описание, ing — состав, vars — варианты (размеры), m — объём/вес,
p — цена, nut — КБЖУ (cal, pro, fat, carb), t — тип, app — к каким разделам, opts — варианты, def — по умолчанию.

Правила:
1. Ответ — только JSON-объект, без пояснений и без ```.
2. Ничего не выдумывай. Чего нет на фото (описание, состав, объём/вес, КБЖУ) — пиши null.
3. cid — только один из этих разделов:
{cats}
   Если ничего не подходит — other. В cats[].n пиши название раздела так, как оно написано на фото.
   Напитки (в том числе глинтвейн, какао, урбеч, молочные коктейли) — только в разделы напитков
   (coffee, tea, cocoa, cold_drinks), никогда не в блюда.
4. p — число без пробелов и знака валюты: «1 290 ₸» → 1290.
5. Один напиток в нескольких размерах (S/M/L, 250/350 мл) — одна позиция с несколькими vars,
   в m пиши объём или вес как на фото («350 мл», «150 г»), если не указан — null.
6. Добавки с доплатой (сиропы, альтернативное молоко, доп. шот), если они есть на фото, — в mods:
   t "single" — выбирается одно (молоко), "multi" — несколько (сиропы); app — id разделов.
   Если добавок на фото нет — "mods": [].
7. Названия пиши как на фото, исправляя только явные ошибки распознавания.
8. Если на фото нет меню — верни {{"cats": [], "mods": [], "itms": []}}.
9. Фото может быть фрагментом длинного меню. Карточку, обрезанную верхним или нижним краем
   (не видно названия или цены целиком), пропусти — она целиком есть на соседнем фрагменте.
10. Цену читай очень внимательно, цифра за цифрой: 990, 1090 и 1290 — разные цены.
11. Блоки «Популярное», «Хиты», «Рекомендуем», «Новинки» — не разделы: позиции из них всё равно
    переписывай, cid выбирай по смыслу позиции, а сам блок в cats не добавляй.
12. ic — один эмодзи, который точнее всего изображает позицию: 🍋 лимонад, 🍒 вишнёвый колд брю,
    🥜 урбеч, 🍵 матча, 🍫 горячий шоколад, 🥛 молочный коктейль, ☕ классический кофе.

Шаблон (пустой):
{json.dumps(template, ensure_ascii=False, separators=(',', ':'))}

Пример правильно заполненного ответа (позиции придуманы — бери данные только с фото):
{json.dumps(shorten_keys(PROMPT_EXAMPLE), ensure_ascii=False, separators=(',', ':'))}"""


def extract_json(text):
    """Достаёт JSON из ответа модели, даже если она обернула его в ``` или добавила текст."""
    text = re.sub(r'^```(?:json)?|```$', '', text.strip(), flags=re.M).strip()
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        raise ValueError('в ответе нет JSON')
    return json.loads(text[start:end + 1])


RETRY_WAITS = (5, 15, 30, 60)  # секунды между попытками: сервер перегружен — даём ему передохнуть
# Лимит ключа llm.alem.ai — 15 запросов в минуту: держим паузу между запросами, чтобы не упираться в него
MIN_INTERVAL = float(os.environ.get('GEMMA_MIN_INTERVAL', '4.5'))
_last_call = [0.0]


def _pace():
    wait = _last_call[0] + MIN_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.monotonic()


def call_model(client, model, messages, max_tokens):
    """Запрос к модели с повторами: при перегрузке, лимите запросов, сетевом сбое и битом JSON.
    Возвращает (JSON из ответа, текст ответа)."""
    last_error, last_exc = None, None
    for attempt in range(len(RETRY_WAITS) + 1):
        try:
            _pace()
            resp = client.chat.completions.create(model=model, temperature=0, max_tokens=max_tokens, messages=messages,
                                                  response_format={'type': 'json_object'})  # ответ — только JSON
            text = resp.choices[0].message.content or ''
            return expand_keys(extract_json(text)), text
        except (ValueError, json.JSONDecodeError) as e:
            last_error, last_exc = f'модель вернула некорректный JSON: {e}', None
        except Exception as e:  # сеть, лимиты, перегрузка, неверный ключ — сообщение от сервера
            last_exc = e
            status = getattr(e, 'status_code', None)
            last_error = f'{type(e).__name__}{f" {status}" if status else ""}: {e}'
            if status in (400, 401, 403, 404):
                break  # неверный ключ, модель или запрос — повторять бессмысленно
        if attempt == len(RETRY_WAITS):
            break
        wait = RETRY_WAITS[attempt]
        # сервер может сам сказать, сколько ждать (Retry-After)
        headers = getattr(getattr(last_exc, 'response', None), 'headers', None) or {}
        if str(headers.get('retry-after', '')).isdigit():
            wait = max(wait, min(120, int(headers['retry-after'])))
        print(f'    попытка {attempt + 1} не удалась ({last_error[:150]}), повтор через {wait} с')
        time.sleep(wait)
    raise RuntimeError(last_error)


def ask_model(client, model, prompt, data_url):
    """Распознаёт меню на одном фото или фрагменте."""
    return call_model(client, model, [
        {'role': 'system', 'content': 'Ты точно переписываешь меню кофеен с фотографий в JSON. Отвечаешь только JSON.'},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': data_url}},
        ]},
    ], max_tokens=8192)


# ───────── приведение ответа модели к формату сайта

TR = dict(zip('абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі',
              ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't',
               'u', 'f', 'h', 'ts', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya',
               'a', 'g', 'k', 'n', 'o', 'u', 'u', 'h', 'i']))


def slug(text):
    s = ''.join(TR.get(ch, ch) for ch in str(text).lower())
    return re.sub(r'[^a-z0-9]+', '_', s).strip('_')


def text_or_null(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def icon_or_null(v):
    """Эмодзи позиции: одна-две картинки без букв и цифр, иначе null (на сайте будет значок раздела)."""
    s = text_or_null(v)
    return s if s and len(s) <= 8 and not re.search(r'[\w\s]', s) else None


def tidy_name(v):
    """«КОФЕ» → «Кофе»: в меню заголовки часто набраны капсом, на сайте это выглядит крикливо.
    Короткие слова (KFC, РАФ) не трогаем. Висящий дефис («Чай клубника-малина-» — название
    обрезано в самом меню) убираем."""
    s = text_or_null(v)
    s = s.rstrip(' -–—') or s if s else s
    return s[0] + s[1:].lower() if s and s.isupper() and len(s) > 3 else s


def to_price(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return round(v) if v > 0 else None
    if isinstance(v, str):
        s = re.sub(r'[\s ₸тгTKZkzт.]+$', '', v.strip())       # «1 290 ₸», «990тг»
        s = re.sub(r'[\s ]', '', s)
        if re.fullmatch(r'\d{1,3}([.,]\d{3})+', s):  # «1.290» / «1,290» — разделитель тысяч
            s = re.sub(r'[.,]', '', s)
        s = s.replace(',', '.')
        if re.fullmatch(r'\d+(\.\d+)?', s):
            return round(float(s)) or None
    return None


def to_number(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).replace(',', '.'))
    except ValueError:
        return None


def nutrition(v):
    if not isinstance(v, dict):
        return None
    n = {k: to_number(v.get(k)) for k in ('calories', 'proteins', 'fats', 'carbs')}
    # одни нули/пусто — значит КБЖУ на фото не было
    return n if any(x not in (None, 0) for x in n.values()) else None


POPULAR_RE = re.compile(r'популяр|хит|рекоменд|бестселл|новинк|popular|best|hits?\b', re.I)


class MenuBuilder:
    """Копит разделы, добавки и позиции со всех фото и следит, чтобы id не повторялись."""

    def __init__(self, cafe_id, styles):
        self.cafe_id = cafe_id
        self.styles = {s['id']: s for s in styles}
        self.categories = {}       # id → раздел
        self.groups = {}           # id → группа добавок
        self.items = []
        self.item_ids = set()
        self.named = set()         # разделы, у которых уже есть настоящее название с фото
        self.by_key = {}           # название → id позиции (чтобы привязать фото)
        self.seen = set()          # названия: одна позиция на разных фото/фрагментах и в «Популярном»
        self.warnings = []

    def category_id(self, raw):
        cid = str(raw or '').strip()
        return cid if cid in self.styles else 'other'

    def add_category(self, raw_id, name=None):
        cid = self.category_id(raw_id)
        name = tidy_name(name)
        if name and POPULAR_RE.search(name):
            name = None  # «Популярное» — витрина, а не раздел; его именем раздел не называем
        if cid not in self.categories:
            style = self.styles.get(cid, {})
            self.categories[cid] = {
                'id': cid,
                'name': name or style.get('name', cid),
                'icon': style.get('emoji'),
                'order': len(self.categories) + 1,
            }
        elif name and cid not in self.named:
            self.categories[cid]['name'] = name  # раньше было стандартное имя — берём настоящее с фото
        if name:
            self.named.add(cid)
        return cid

    def add(self, data, source):
        if not isinstance(data, dict):
            self.warnings.append(f'{source}: ответ не является объектом JSON')
            return 0

        names = {}
        for c in data.get('categories') or []:
            if isinstance(c, dict):
                names[self.category_id(c.get('id'))] = c.get('name')
                self.add_category(c.get('id'), c.get('name'))

        for g in data.get('modifier_groups') or []:
            self.add_group(g, source)

        added = 0
        for raw in data.get('items') or []:
            if self.add_item(raw, names, source):
                added += 1
        return added

    def add_group(self, g, source):
        if not isinstance(g, dict) or not text_or_null(g.get('name')):
            return
        gid = slug(g.get('id') or g.get('name')) or 'extra'
        options = []
        for o in g.get('options') or []:
            if not isinstance(o, dict) or not text_or_null(o.get('name')):
                continue
            option = {'id': slug(o.get('id') or o['name']) or f'opt{len(options) + 1}',
                      'name': o['name'].strip(), 'price': to_price(o.get('price')) or 0}
            if o.get('default') is True:
                option['default'] = True
            options.append(option)
        if not options:
            return
        group = {
            'id': gid,
            'name': tidy_name(g['name']),
            'type': 'multi' if g.get('type') == 'multi' else 'single',
            'applies_to': [c for c in (g.get('applies_to') or []) if c in self.styles],
            'options': options,
        }
        if gid in self.groups:  # та же группа на другом фото — добавляем новые варианты
            known = {o['id'] for o in self.groups[gid]['options']}
            self.groups[gid]['options'] += [o for o in options if o['id'] not in known]
        else:
            self.groups[gid] = group

    def add_item(self, raw, names, source):
        if not isinstance(raw, dict) or not text_or_null(raw.get('name')):
            return False
        name = tidy_name(raw['name'])
        cid = self.add_category(raw.get('category_id'), names.get(self.category_id(raw.get('category_id'))))

        key = re.sub(r'\s+', ' ', name.lower().replace('ё', 'е'))
        if key in self.seen:
            return False  # уже есть: с другого фото, из перекрытия фрагментов или из блока «Популярное»
        self.seen.add(key)

        variants = []
        for v in raw.get('variants') or []:
            if not isinstance(v, dict):
                continue
            price = to_price(v.get('price'))
            if price is None:
                continue
            variants.append({'measure': text_or_null(v.get('measure')), 'price': price, 'nutrition': nutrition(v.get('nutrition'))})
        if not variants and to_price(raw.get('price')):  # модель могла написать цену прямо у позиции
            variants.append({'measure': None, 'price': to_price(raw['price']), 'nutrition': None})
        if not variants:
            self.warnings.append(f'{source}: «{name}» пропущена — не распознана цена')
            return False

        # id — всегда из названия: модель иногда повторяет один id у разных позиций
        stem = slug(name) or 'item'
        item_id = f'item_{stem}'
        n = 2
        while item_id in self.item_ids:
            item_id = f'item_{stem}_{n}'
            n += 1
        self.item_ids.add(item_id)
        stem = item_id.removeprefix('item_')

        ingredients = [str(x).strip() for x in raw.get('ingredients') or [] if str(x).strip()]
        self.by_key[key] = item_id
        self.items.append({
            'id': item_id,
            'category_id': cid,
            'name': name,
            'image_url': None,             # проставляется, если фото позиции удалось вырезать
            'icon': icon_or_null(raw.get('icon')),
            'description': text_or_null(raw.get('description')),
            'ingredients': ingredients or None,
            'prep_time_min': None,
            'is_special': False,
            'variants': [{'variant_id': f'var_{stem}_{"std" if len(variants) == 1 else i + 1}', **v}
                         for i, v in enumerate(variants)],
        })
        return True

    def find_id(self, name):
        """id позиции по названию, как его написала модель (без учёта регистра, ё/е и пробелов).
        На карточке длинное название бывает обрезано («Батч смородиновы...») — тогда ищем позицию,
        чьё название начинается так же, если такая ровно одна."""
        key = re.sub(r'\s+', ' ', (tidy_name(name) or '').lower().replace('ё', 'е'))
        if key in self.by_key:
            return self.by_key[key]
        stem = re.sub(r'[.…]+$', '', key).strip()
        if len(stem) >= 4:
            matches = [k for k in self.by_key if k.startswith(stem)]
            if len(matches) == 1:
                return self.by_key[matches[0]]
        return None

    def result(self):
        used = {i['category_id'] for i in self.items}
        categories = [c for c in self.categories.values() if c['id'] in used]
        for i, c in enumerate(categories, 1):
            c['order'] = i
        return {'categories': categories, 'modifier_groups': list(self.groups.values()), 'items': self.items}


def last_section_name(data):
    """Название раздела, которым заканчивается ответ модели по фрагменту, — подсказка для следующего."""
    if not isinstance(data, dict):
        return None
    names = {c.get('id'): c.get('name') for c in data.get('categories') or [] if isinstance(c, dict)}
    items = [i for i in data.get('items') or [] if isinstance(i, dict)]
    if items and names.get(items[-1].get('category_id')):
        return text_or_null(names[items[-1]['category_id']])
    cats = [c for c in data.get('categories') or [] if isinstance(c, dict)]
    return text_or_null(cats[-1].get('name')) if cats else None


# ───────── целая вкладка: сведения, меню, фотографии, ответы модели

def notice(level, text):
    """Сообщение в лог; в GitHub Actions — ещё и аннотация на странице задачи."""
    print(f'::{level}::{text}' if os.environ.get('GITHUB_ACTIONS') else f'  {"⚠" if level == "warning" else "✗"} {text}')


def cafe_info(photos_dir, cafe_id):
    """Необязательный cafe.json рядом с фото: {"name": "...", "address": "...", "city": "...", "hours": "..."}."""
    info = load_json(photos_dir / 'cafe.json', {}) or {}
    name = text_or_null(info.get('name')) or cafe_id.replace('_', ' ').title()
    return {k: text_or_null(info.get(k)) for k in ('address', 'city', 'hours', 'logo')} | {'name': name}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def logo_file(photos_dir, info):
    """Логотип из папки исходников; поддерживаем также прежний путь от корня сайта."""
    if not info.get('logo'):
        return None
    for path in (photos_dir / info['logo'], SITE / info['logo']):
        if path.is_file():
            return path.resolve()
    raise ValueError(f'Логотип не найден: {info["logo"]}')


def write_tab(folder, cafe_id, info, menu, crops, logo=None):
    """Все файлы заведения в одной папке. Индекс обновляется после записи вкладки."""
    folder = folder.resolve()
    on_site = folder.parent == (SITE / 'tabs').resolve()
    previous = load_json(folder / 'cafe.json', {}) or {}
    if on_site and (folder / 'menu.json').exists() and previous.get('source') != 'photos':
        raise ValueError(f'Вкладка «{cafe_id}» создана вручную; используйте --out для отдельной копии')
    folder.mkdir(parents=True, exist_ok=True)
    entry = {'id': cafe_id, 'currency': 'KZT', 'theme': {'accent': None}, **previous,
             **{k: v for k, v in info.items() if v is not None and k != 'logo'}, 'source': 'photos'}
    entry.setdefault('logo', None)
    for key in ('address', 'city', 'hours'):
        entry.setdefault(key, None)
    if logo:
        entry['logo'] = f'logo{logo.suffix.lower()}'
        target = folder / entry['logo']
        if logo.resolve() != target.resolve():
            shutil.copy2(logo, target)
    for item in menu['items']:
        img = crops.get(item['id'])
        if img is None:
            continue
        (folder / 'images').mkdir(exist_ok=True)
        img.thumbnail((600, 600))
        item['image_url'] = f'images/{item["id"]}.jpg'
        img.save(folder / item['image_url'], 'JPEG', quality=85, optimize=True)
    write_json(folder / 'menu.json', menu)
    write_json(folder / 'cafe.json', entry)
    if on_site:
        index_path = SITE / 'tabs' / 'index.json'
        index = load_json(index_path, {}) or {}
        folders = index.setdefault('tabs', [])
        if folder.name not in folders:
            folders.append(folder.name)
        write_json(index_path, index)


# ───────── запуск

def main():
    parser = argparse.ArgumentParser(description='Фото меню → целая вкладка в coffee-menu/tabs/<id>/')
    parser.add_argument('photos', help='папка заведения с cafe.json и скриншотами, например venues/dodo_pizza')
    parser.add_argument('--cafe-id', help='id кофейни латиницей, например ayu_menu (по умолчанию — имя папки)')
    parser.add_argument('--out', help='папка готовой вкладки (по умолчанию coffee-menu/tabs/<id>/)')
    parser.add_argument('--max-width', type=int, default=1600,
                        help='ширина, до которой уменьшается фото, px (длинные фото режутся на фрагменты по высоте)')
    parser.add_argument('--no-photos', dest='photos_from_menu', action='store_false',
                        help='не вырезать фото позиций из меню (быстрее: один запрос к модели на фрагмент)')
    parser.add_argument('--from-cache', action='store_true',
                        help='брать сохранённые ответы модели (raw/ в папке вкладки) вместо новых запросов — '
                             'чтобы заново собрать меню и вырезать фото после правок скрипта')
    parser.add_argument('--publish', action='store_true',
                        help='совместимость со старым запуском: теперь вкладка по умолчанию сохраняется на сайт')
    args = parser.parse_args()

    load_env(HERE / '.env')
    api_key = os.environ.get('OPENAI_API_KEY', '').strip()
    base_url = os.environ.get('OPENAI_BASE_URL', 'https://llm.alem.ai/v1').strip()
    model = os.environ.get('GEMMA_MODEL', 'gemma4').strip()
    if not api_key or api_key == 'Ваш API_KEY':
        sys.exit('Нет API-ключа: впишите его в menu_parser/.env (OPENAI_API_KEY=...)')

    photos_dir = Path(args.photos)
    if not photos_dir.is_absolute():
        photos_dir = (Path.cwd() / photos_dir) if (Path.cwd() / photos_dir).exists() else HERE / photos_dir
    cafe_id = slug(args.cafe_id or photos_dir.name)
    if not cafe_id:
        parser.error('Не удалось получить id заведения; задайте --cafe-id латиницей')
    info = cafe_info(photos_dir, cafe_id)
    try:
        logo = logo_file(photos_dir, info)
    except ValueError as e:
        parser.error(str(e))
    photos = sorted(p for p in photos_dir.glob('*') if p.is_file() and p.suffix.lower() in IMAGE_EXT
                    and p.resolve() != logo)
    if not photos:
        sys.exit(f'В папке {photos_dir} нет фото ({", ".join(sorted(IMAGE_EXT))})')

    out = Path(args.out).resolve() if args.out else SITE / 'tabs' / cafe_id
    if out.suffix.lower() == '.json':
        parser.error('--out теперь принимает папку вкладки, например output/tabs/my_cafe')
    if out.parent.resolve() == (SITE / 'tabs').resolve():
        previous = load_json(out / 'cafe.json', {}) or {}
        if (out / 'menu.json').exists() and previous.get('source') != 'photos':
            out = HERE / 'output' / 'tabs' / cafe_id
            notice('warning', f'Ручное меню сохранено. Новая вкладка будет записана отдельно: {out}')
    raw_dir = out / 'raw'
    raw_dir.mkdir(parents=True, exist_ok=True)

    try:
        from openai import OpenAI
    except ImportError:
        sys.exit('Не установлена библиотека openai. Выполните: pip install -r requirements.txt')
    # повторы делает call_model (с паузами), встроенные повторы библиотеки выключены
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=180, max_retries=0)

    etalon = load_json(HERE / 'etalon.json')
    styles = (load_json(SITE / 'data' / 'categories.json', {}) or {}).get('categories', [])
    prompt = build_prompt(etalon, styles)

    print(f'Модель: {model} ({base_url})')
    print(f'Кофейня: {cafe_id}, фото: {len(photos)}\n')

    builder = MenuBuilder(cafe_id, styles)
    failed = []
    crops = {}  # id позиции → вырезанное фото (сохраняются в конце, когда ясно, куда пишется меню)
    for n, photo in enumerate(photos, 1):
        tiles = image_tiles(photo, args.max_width)
        print(f'[{n}/{len(photos)}] {photo.name}' + (f' — {len(tiles)} фрагм.' if len(tiles) > 1 else ''))
        last_section = None  # раздел, которым закончился предыдущий фрагмент
        for k, (tile_img, tile) in enumerate(tiles, 1):
            label = f'{photo.name} [{k}/{len(tiles)}]' if len(tiles) > 1 else photo.name
            context = (f'\n\nЭто фрагмент {k} из {len(tiles)} одного длинного меню. На предыдущем фрагменте последним '
                       f'был раздел «{last_section}» — позиции в начале этого фрагмента до первого заголовка относятся к нему.'
                       if k > 1 and last_section else '')
            suffix = f'_{k:02d}' if len(tiles) > 1 else ''
            raw_menu = raw_dir / f'{photo.stem}{suffix}.json'
            raw_boxes = raw_dir / f'{photo.stem}{suffix}.photos.json'
            try:
                if args.from_cache and raw_menu.exists():  # ответ уже есть — модель не спрашиваем
                    text = raw_menu.read_text(encoding='utf-8')
                    data = expand_keys(extract_json(text))
                else:
                    data, text = ask_model(client, model, prompt + context, tile)
            except Exception as e:
                print(f'    ✗ {label}: не распознано: {e}')
                failed.append(label)
                continue
            raw_menu.write_text(text, encoding='utf-8')  # сырой ответ — для проверки и для --from-cache
            print(f'    ✓ {label}: новых позиций {builder.add(data, label)}')
            last_section = last_section_name(data) or last_section

            if tile_img is not None and args.photos_from_menu:
                found = 0
                if args.from_cache and raw_boxes.exists():
                    boxes = json.loads(raw_boxes.read_text(encoding='utf-8'))
                else:
                    boxes = ask_photos(client, model, tile)
                # рамки модели — рядом с сырыми ответами: по ним можно перепроверить вырезание без новых запросов
                raw_boxes.write_text(json.dumps(boxes, ensure_ascii=False), encoding='utf-8')
                for p in boxes:
                    item_id = builder.find_id(p['name'])
                    if item_id and item_id not in crops:
                        img = crop_photo(tile_img, p['box'])
                        if img is not None:
                            crops[item_id] = img
                            found += 1
                if found:
                    print(f'      фото позиций: {found}')

    menu = builder.result()
    if not menu['items']:
        # пустой результат не записываем — иначе он затёр бы прежнее меню
        notice('error', f'«{cafe_id}»: не распознано ни одной позиции, меню не изменено')
        sys.exit(1)

    if failed:
        # часть фрагментов не распознана — неполное меню на сайт не пишем, прежнее остаётся
        notice('error', f'«{cafe_id}»: не распознаны {", ".join(failed)} — меню на сайте не изменено. '
                        f'Запустите распознавание ещё раз.')
        sys.exit(1)
    write_tab(out, cafe_id, info, menu, crops, logo)

    with_icon = sum(1 for i in menu['items'] if not i['image_url'] and i['icon'])
    print(f'\nГотово: {out}')
    print(f'  разделов: {len(menu["categories"])}, позиций: {len(menu["items"])}, групп добавок: {len(menu["modifier_groups"])}')
    print(f'  фото из меню: {len(crops)} (в {out / "images"}), остальным — эмодзи: {with_icon}')
    for w in builder.warnings:
        notice('warning', w)
    if failed:
        notice('warning', f'не распознаны фото: {", ".join(failed)}')
    print('\nПроверьте распознанные цены и названия в menu.json.')


if __name__ == '__main__':
    main()
