"""Распознаёт фото меню кофейни через Gemma и собирает JSON для сайта.

Формат результата — как coffee-menu/cafes/master_coffe.json (пустой шаблон — etalon.json).
Каждое фото отправляется в модель отдельно, позиции со всех фото объединяются в одно меню,
а ответ модели проверяется и приводится к формату сайта: цены — числами, неизвестное — null,
id — латиницей, пути к фото — pictures/items/<кофейня>/<id>.jpg.

Запуск (из папки menu_parser):
  pip install -r requirements.txt
  python driver.py photos/ayu --cafe-id ayu_menu
  python driver.py photos/ayu --cafe-id ayu_menu --out ../coffee-menu/cafes/ayu_menu.json

Ключ API — в файле .env рядом со скриптом (OPENAI_API_KEY=...).
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import re
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
        return json.loads(path.read_text(encoding='utf-8'))
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
    """Список data URL: одно фото — один или несколько фрагментов сверху вниз."""
    try:
        from PIL import Image, ImageOps
    except ImportError:  # без Pillow отправляем как есть
        mime = mimetypes.guess_type(path.name)[0] or 'image/jpeg'
        return [f'data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}']

    im = ImageOps.exif_transpose(Image.open(path))  # фото с телефона бывают повёрнуты
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    w, h = im.size
    tile_h = max(TILE_HEIGHT, round(w * 1.2))
    if h <= tile_h * 1.15:
        return [to_data_url(im)]

    step = tile_h - TILE_OVERLAP
    tops = list(range(0, h - tile_h, step)) + [h - tile_h]  # последний фрагмент — ровно до низа
    return [to_data_url(im.crop((0, top, w, top + tile_h))) for top in tops]


# ───────── запрос к модели

def build_prompt(etalon, categories, example):
    cats = '\n'.join(f'  - {c["id"]} — {c["name"]}' for c in categories if c['id'] != 'other')
    return f"""На фото — страница меню кофейни. Перепиши ВСЕ позиции с фото в JSON строго по шаблону.

Правила:
1. Ответ — только JSON-объект, без пояснений и без ```.
2. Ничего не выдумывай. Чего нет на фото (описание, состав, объём/вес, КБЖУ, время приготовления) — пиши null.
3. category_id — только один из этих разделов:
{cats}
   Если ничего не подходит — other. В categories[].name пиши название раздела так, как оно написано на фото.
   Напитки (в том числе глинтвейн, какао, урбеч, молочные коктейли) — только в разделы напитков
   (coffee, tea, cocoa, cold_drinks), никогда не в блюда.
4. price — число без пробелов и знака валюты: «1 290 ₸» → 1290.
5. Один напиток в нескольких размерах (S/M/L, 250/350 мл) — одна позиция с несколькими variants,
   в measure пиши объём или вес как на фото («350 мл», «150 г»), если не указан — null.
6. id позиции — латиницей в snake_case с префиксом item_ (Капучино → item_kapuchino).
7. Добавки с доплатой (сиропы, альтернативное молоко, доп. шот), если они есть на фото, — в modifier_groups:
   type "single" — выбирается одно (молоко), "multi" — несколько (сиропы); applies_to — id разделов.
   Если добавок на фото нет — "modifier_groups": [].
8. Названия пиши как на фото, исправляя только явные ошибки распознавания.
9. Если на фото нет меню — верни {{"categories": [], "modifier_groups": [], "items": []}}.
10. Фото может быть фрагментом длинного меню. Карточку, обрезанную верхним или нижним краем
    (не видно названия или цены целиком), пропусти — она целиком есть на соседнем фрагменте.
11. Цену читай очень внимательно, цифра за цифрой: 990, 1090 и 1290 — разные цены.
12. Блоки «Популярное», «Хиты», «Рекомендуем», «Новинки» — не разделы: позиции из них всё равно
    переписывай, category_id выбирай по смыслу позиции, а сам блок в categories не добавляй.

Шаблон (пустой):
{json.dumps(etalon, ensure_ascii=False, indent=2)}

Пример правильно заполненного фрагмента:
{json.dumps(example, ensure_ascii=False, indent=2)}"""


def extract_json(text):
    """Достаёт JSON из ответа модели, даже если она обернула его в ``` или добавила текст."""
    text = re.sub(r'^```(?:json)?|```$', '', text.strip(), flags=re.M).strip()
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        raise ValueError('в ответе нет JSON')
    return json.loads(text[start:end + 1])


def ask_model(client, model, prompt, data_url, attempts=3):
    """Один запрос на одно фото. Повторяет при сетевой ошибке и при битом JSON."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            resp = client.chat.completions.create(
                model=model,
                temperature=0,
                max_tokens=8192,
                messages=[
                    {'role': 'system', 'content': 'Ты точно переписываешь меню кофеен с фотографий в JSON. Отвечаешь только JSON.'},
                    {'role': 'user', 'content': [
                        {'type': 'text', 'text': prompt},
                        {'type': 'image_url', 'image_url': {'url': data_url}},
                    ]},
                ],
            )
            text = resp.choices[0].message.content or ''
            return extract_json(text), text
        except (ValueError, json.JSONDecodeError) as e:
            last_error = f'модель вернула некорректный JSON: {e}'
        except Exception as e:  # сеть, лимиты, неверный ключ — сообщение от сервера
            last_error = str(e)
            if 'auth' in last_error.lower() or '401' in last_error:
                break  # неверный ключ — повторять бессмысленно
        print(f'    попытка {attempt}/{attempts} не удалась: {last_error}')
        time.sleep(2 * attempt)
    raise RuntimeError(last_error)


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
        self.items.append({
            'id': item_id,
            'category_id': cid,
            'name': name,
            'image_url': f'pictures/items/{self.cafe_id}/{item_id}.jpg',
            'description': text_or_null(raw.get('description')),
            'ingredients': ingredients or None,
            'prep_time_min': None,
            'is_special': False,
            'variants': [{'variant_id': f'var_{stem}_{"std" if len(variants) == 1 else i + 1}', **v}
                         for i, v in enumerate(variants)],
        })
        return True

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


# ───────── публикация на сайт (--publish)

def notice(level, text):
    """Сообщение в лог; в GitHub Actions — ещё и аннотация на странице задачи."""
    print(f'::{level}::{text}' if os.environ.get('GITHUB_ACTIONS') else f'  {"⚠" if level == "warning" else "✗"} {text}')


def cafe_info(photos_dir, cafe_id):
    """Необязательный cafe.json рядом с фото: {"name": "...", "address": "...", "city": "...", "hours": "..."}."""
    info = load_json(photos_dir / 'cafe.json', {}) or {}
    name = text_or_null(info.get('name')) or cafe_id.replace('_', ' ').title()
    return {k: text_or_null(info.get(k)) for k in ('address', 'city', 'hours', 'logo')} | {'name': name}


def publish(menu, cafe_id, info):
    """Пишет меню в coffee-menu/cafes и регистрирует кофейню в coffee-menu/data/cafes.json.
    Меню, сделанные вручную (без "source": "photos"), не перезаписываются. Возвращает путь к файлу."""
    reg_path = SITE / 'data' / 'cafes.json'
    registry = load_json(reg_path, {}) or {}
    cafes = registry.setdefault('cafes', [])
    entry = next((c for c in cafes if c.get('id') == cafe_id), None)

    if entry and entry.get('source') != 'photos':
        out = HERE / 'output' / f'{cafe_id}.json'
        notice('warning', f'Кофейня «{cafe_id}» сделана вручную — её меню на сайте не перезаписано. '
                          f'Результат распознавания: menu_parser/output/{cafe_id}.json')
        return out

    if entry is None:
        entry = {'id': cafe_id, 'name': info['name'], 'file': f'cafes/{cafe_id}.json', 'logo': info['logo'],
                 'address': info['address'], 'city': info['city'], 'hours': info['hours'],
                 'currency': 'KZT', 'theme': {'accent': None}, 'source': 'photos'}
        cafes.append(entry)
    else:  # обновляем то, что указано в cafe.json
        entry.update({k: v for k, v in info.items() if v})
    reg_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return SITE / entry['file']


# ───────── запуск

def main():
    parser = argparse.ArgumentParser(description='Фото меню → JSON для сайта (через Gemma)')
    parser.add_argument('photos', nargs='?', default='photos', help='папка с фото меню (по умолчанию photos)')
    parser.add_argument('--cafe-id', help='id кофейни латиницей, например ayu_menu (по умолчанию — имя папки)')
    parser.add_argument('--out', help='куда сохранить JSON (по умолчанию output/<cafe-id>.json)')
    parser.add_argument('--max-width', type=int, default=1600,
                        help='ширина, до которой уменьшается фото, px (длинные фото режутся на фрагменты по высоте)')
    parser.add_argument('--publish', action='store_true',
                        help='сразу на сайт: coffee-menu/cafes/<id>.json + регистрация в coffee-menu/data/cafes.json')
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
    photos = sorted(p for p in photos_dir.glob('*') if p.suffix.lower() in IMAGE_EXT)
    if not photos:
        sys.exit(f'В папке {photos_dir} нет фото ({", ".join(sorted(IMAGE_EXT))})')

    cafe_id = slug(args.cafe_id or (photos_dir.name if photos_dir.name != 'photos' else 'new_cafe'))
    out = Path(args.out) if args.out else HERE / 'output' / f'{cafe_id}.json'
    raw_dir = HERE / 'output' / 'raw' / cafe_id
    raw_dir.mkdir(parents=True, exist_ok=True)

    try:
        from openai import OpenAI
    except ImportError:
        sys.exit('Не установлена библиотека openai. Выполните: pip install -r requirements.txt')
    client = OpenAI(api_key=api_key, base_url=base_url)

    etalon = load_json(HERE / 'etalon.json')
    styles = (load_json(SITE / 'data' / 'categories.json', {}) or {}).get('categories', [])
    sample = load_json(SITE / 'cafes' / 'master_coffe.json', {}) or {}
    example = {'categories': sample.get('categories', [])[:1],
               'items': [{k: v for k, v in i.items() if k not in ('i18n', 'modifier_group_ids')}
                         for i in sample.get('items', [])[:2]]}
    prompt = build_prompt(etalon, styles, example)

    print(f'Модель: {model} ({base_url})')
    print(f'Кофейня: {cafe_id}, фото: {len(photos)}\n')

    builder = MenuBuilder(cafe_id, styles)
    failed = []
    for n, photo in enumerate(photos, 1):
        tiles = image_tiles(photo, args.max_width)
        print(f'[{n}/{len(photos)}] {photo.name}' + (f' — {len(tiles)} фрагм.' if len(tiles) > 1 else ''))
        last_section = None  # раздел, которым закончился предыдущий фрагмент
        for k, tile in enumerate(tiles, 1):
            label = f'{photo.name} [{k}/{len(tiles)}]' if len(tiles) > 1 else photo.name
            context = (f'\n\nЭто фрагмент {k} из {len(tiles)} одного длинного меню. На предыдущем фрагменте последним '
                       f'был раздел «{last_section}» — позиции в начале этого фрагмента до первого заголовка относятся к нему.'
                       if k > 1 and last_section else '')
            try:
                data, text = ask_model(client, model, prompt + context, tile)
            except Exception as e:
                print(f'    ✗ {label}: не распознано: {e}')
                failed.append(label)
                continue
            suffix = f'_{k:02d}' if len(tiles) > 1 else ''
            (raw_dir / f'{photo.stem}{suffix}.json').write_text(text, encoding='utf-8')  # сырой ответ — для проверки
            print(f'    ✓ {label}: новых позиций {builder.add(data, label)}')
            last_section = last_section_name(data) or last_section

    menu = builder.result()
    if not menu['items']:
        # пустой результат не записываем — иначе он затёр бы прежнее меню
        notice('error', f'«{cafe_id}»: не распознано ни одной позиции, меню не изменено')
        sys.exit(1)

    if args.publish:
        out = publish(menu, cafe_id, cafe_info(photos_dir, cafe_id))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(menu, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

    print(f'\nГотово: {out}')
    print(f'  разделов: {len(menu["categories"])}, позиций: {len(menu["items"])}, групп добавок: {len(menu["modifier_groups"])}')
    for w in builder.warnings:
        notice('warning', w)
    if failed:
        notice('warning', f'не распознаны фото: {", ".join(failed)}')
    if not args.publish:
        print('\nПроверьте цены и названия, прежде чем копировать файл в coffee-menu/cafes/.')


if __name__ == '__main__':
    main()
