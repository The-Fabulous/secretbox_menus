# Secretbox — меню кофеен

Сайт: https://the-fabulous.github.io/secretbox_menus/

## Добавить или обновить заведение

Откройте **[venues/](venues/)**: внутри находится отдельная папка каждого заведения с `cafe.json` и скриншотами меню. Здесь загружаются исходные файлы; обработчик находится в `menu_parser/`, готовый сайт — в `coffee-menu/`.

Пример: `venues/dodo_pizza/cafe.json` задаёт название и сведения о заведении, а изображения рядом — его меню. [Инструкция и пример конфига](venues/README.md).

## Приложение и публикация

Исходники приложения находятся в `coffee-menu/`. Инструкции по данным и локальному запуску: [coffee-menu/README.md](coffee-menu/README.md).

GitHub Actions публикует содержимое `coffee-menu/` в GitHub Pages при каждом push в `main`. В Settings → Pages источник публикации должен быть **GitHub Actions**.
