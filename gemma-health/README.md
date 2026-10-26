# Проверка Gemma для сайта (без утечки ключа)

`worker.js` — маленький сервер на Cloudflare Workers. Кнопка «API» на сайте спрашивает его «Gemma работает?», он сам отправляет в Gemma короткий запрос со своим ключом и отвечает только «да/нет, код, время». Ключ хранится в секретах Cloudflare — его нет ни на сайте, ни в браузере, ни в репозитории. Результат держится минуту, так что частые нажатия не тратят запросы к Gemma.

## Развёртывание (один раз, ~5 минут, бесплатно)

1. Зарегистрируйтесь на https://dash.cloudflare.com (бесплатный тариф).
2. **Workers & Pages → Create → Create Worker** → имя `gemma-health` → **Deploy**.
3. **Edit code** → удалите пример, вставьте всё содержимое `worker.js` → **Deploy**.
4. **Settings → Variables and Secrets → Add** → тип **Secret**, имя `GEMMA_API_KEY`, значение — ключ Gemma → **Deploy**.
5. Скопируйте адрес воркера (вида `https://gemma-health.<аккаунт>.workers.dev`) и впишите в `coffee-menu/data/config.json`:
   ```json
   "gemma_health_url": "https://gemma-health.<аккаунт>.workers.dev/health"
   ```
6. Закоммитьте и запушьте `config.json`. Проверка: откройте сайт с `?staff=1` → слева вверху «● API» → «Проверить».

Проверить сам воркер можно, открыв в браузере `https://gemma-health.<аккаунт>.workers.dev/health` — должно быть `{"ok":true,...}`.

## Что отвечает воркер

| Ответ | Значение |
|---|---|
| `"ok": true` | Gemma работает |
| `"status": 401` | неверный ключ в секрете `GEMMA_API_KEY` |
| `"error": "no_key"` | секрет `GEMMA_API_KEY` не задан |
| `"error": "network"` / `"timeout"` | сервер Gemma недоступен / не ответил за 20 с |

Сменили ключ Gemma — обновите секрет в Cloudflare (шаг 4), код и сайт менять не нужно.

Если сайт переедет на другой адрес — добавьте его в `ALLOWED_ORIGINS` в `worker.js`.
