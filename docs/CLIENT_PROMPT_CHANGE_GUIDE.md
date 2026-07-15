# Инструкция для клиента: как менять SMM-промпты

Эта инструкция нужна для случаев, когда нужно поменять правила генерации постов для Telegram и MAX.

## Где лежат промпты

Все основные промпты лежат в одном файле:

```text
src/text/socialPrompts.ts
```

Внутри файла есть блоки:

- `PROMO_PROMPT` — промпт для акций.
- `COMPANY_NEWS_PROMPT` — промпт для новостей.
- `EVENT_PROMPT` — промпт для событий.
- `PRODUCT_NEW_PROMPT` — промпт для новинок товара.
- `FORMAT_ONLY_PROMPT` — запасной промпт для прочих типов постов.
- `PLATFORM_RULES` — общее правило для площадок. Сейчас один текст готовится сразу для Telegram и MAX, а ВК как канал публикации отключён.

## Какой тип поста когда используется

Сервис получает из Bitrix поле `post_type` или название раздела и приводит его к одному из типов:

- `promo` — акции, скидки, распродажи.
- `company_news` — новости компании.
- `event` — события, выставки, мастер-классы.
- `product_new` — новинки товара, новые поступления.
- `entertainment` или `unknown` — всё остальное, без сильного переписывания.

Важно: раздел/тип `Новинки` сейчас попадает в `product_new`, а не в обычную новость.

## Как поменять промпт

1. Откройте файл `src/text/socialPrompts.ts`.
2. Найдите нужный блок, например `PROMO_PROMPT`.
3. Меняйте только текст внутри обратных кавычек:

```ts
const PROMO_PROMPT = `
Текст промпта здесь
`.trim();
```

4. Не удаляйте строку `.trim();` после промпта.
5. Не меняйте названия констант, если не меняете код отдельно.
6. Ссылки в промптах лучше оставлять в формате Markdown:

```text
[текст ссылки](https://example.com)
```

7. Если ВК всё ещё выключен, не делайте ВК основным призывом к действию. Ссылку на группу ВК можно оставлять в блоке контактов как дополнительный контакт.
8. Если меняете лимит длины поста, нужно поменять не только текст промпта, но и константу в `src/text/socialText.ts`:

```ts
export const SOCIAL_AI_TARGET = 1200;
```

## Как проверить после изменения

В корне проекта выполните:

```bash
npm test -- --run tests/openRouterTextFit.test.ts tests/socialText.test.ts tests/parseWebhook.test.ts
npm test
npm run build
```

Что проверяют эти команды:

- `openRouterTextFit.test.ts` — что в OpenRouter уходит нужный промпт.
- `socialText.test.ts` — что лимит и AI-подготовка работают.
- `parseWebhook.test.ts` — что типы постов из Bitrix распознаются правильно.
- `npm test` — что не сломалась остальная публикация.
- `npm run build` — что проект собирается для сервера.

## Как сохранить изменения в Git

На локальном компьютере после успешных тестов:

```bash
git status --short
git add src/text/socialPrompts.ts src/text/socialText.ts tests docs POSTER_BITRIX_EXECPLAN.md
git commit -m "Update social prompts"
git push
```

Если менялся только файл с промптами, можно добавить только его:

```bash
git add src/text/socialPrompts.ts
git commit -m "Update social prompts"
git push
```

## Как выложить изменения на сервер

На сервере:

```bash
cd /opt/bitrix-tg
git status --short
git pull
npm install
npm run build
sudo systemctl restart bitrix-tg
```

Проверка после перезапуска:

```bash
curl https://poster.svarnoy-market.ru/health
sudo systemctl status bitrix-tg --no-pager
journalctl -u bitrix-tg -n 80 --no-pager
```

Ожидаемый ответ health-check:

```text
OK
```

## Если после изменения посты выглядят неправильно

Проверьте по порядку:

1. В `src/text/socialPrompts.ts` изменён правильный блок.
2. В промпте нет требования выбирать ВК как основной CTA.
3. В Bitrix у элемента стоит правильный тип публикации или правильный раздел.
4. На сервере выполнены `git pull`, `npm run build` и `sudo systemctl restart bitrix-tg`.
5. В логах есть строка `AI social text preparation completed`.

Команда для логов:

```bash
journalctl -u bitrix-tg -f
```
