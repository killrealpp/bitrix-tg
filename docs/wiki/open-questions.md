---
title: "Открытые вопросы"
created: 2026-06-04
tags:
  - questions
  - decisions
---

# Открытые вопросы

Эти вопросы нужны, чтобы реализация не угадала неверные правила. Самые важные вопросы стоят сверху.

## Частично зафиксированные defaults

2026-06-04 / Codex: до подтверждения реального production payload сервис использует такие рабочие defaults:

- поле "начало активности" ищется как `ACTIVE_FROM`, `DATE_ACTIVE_FROM`, lower-case aliases, nested `fields.*` / `all_properties.*`, либо как точный путь из `BITRIX_ACTIVE_FROM_FIELD`;
- дата Bitrix формата `DD.MM.YYYY HH:MM:SS` парсится как локальное время сервиса, если в строке нет явного timezone/offset;
- date-only `active_from`, например `11.06.2026`, больше не считается временем публикации: active/social пост получает `failed`, Telegram не вызывается, админ уведомляется;
- текст Telegram собирается из `NAME`/`name`, `PREVIEW_TEXT`/`preview_text`, `DETAIL_TEXT`/`detail_text`, с базовой очисткой HTML и entities;
- URL не добавляется в Telegram-текст, пока не подтверждено поле публичной ссылки;
- media edit policy по умолчанию `rebuild`: при изменении списка фото старые media-сообщения удаляются и актуальный набор публикуется заново. `soft` остается доступным явным режимом через `TELEGRAM_MEDIA_SYNC_POLICY=soft`.
- после real Telegram проверки soft-flow решение для MVP остается доступным как opt-in: удаленные из Битрикс фото остаются в Telegram при `soft`, а production default `rebuild` делает точную синхронизацию с удалением старых сообщений.
- если `active != "Y"` или `pub_news_social` пустой для pending-записи без Telegram-сообщений, отложенная публикация отменяется через статус `ignored`; если уже опубликованный пост пришел как `active: "N"`, Telegram-сообщения удаляются.
- если задан `WEBHOOK_SECRET`, webhook должен передавать его в header `x-webhook-secret`; сравнение constant-time, а `x-webhook-secret` и `authorization` редактируются в request logs.
- Telegram Bot API retry по умолчанию: повторять временные network/`429`/`5xx` ошибки до `TELEGRAM_RETRY_ATTEMPTS=3` с базовой задержкой `TELEGRAM_RETRY_DELAY_MS=500`; постоянные `4xx` не повторяются и переводят строку в `failed`.
- тексты ошибок перед сохранением в `last_error` проходят redaction для Telegram bot-token, `authorization`, `x-webhook-secret`, `TELEGRAM_BOT_TOKEN` и `WEBHOOK_SECRET`.
- unhandled webhook/scheduler/startup ошибки логируются через redacted message/stack, а webhook caller получает generic `internal_error` без raw деталей.
- production payload использует `active_from` как поле начала активности; актуальный пример пришел в формате `11.06.2026 00:05:00`, то есть с точным временем.
- `pub_news_social = null` или пустое значение означает не публиковать; любое непустое значение означает публиковать.
- ссылки в Telegram-пост не добавляются.
- если уже опубликованный пост пришел как `active: "N"`, сервис удаляет Telegram-сообщения и очищает refs.
- если фото удалили в Битрикс, production default `rebuild` удаляет старые media-сообщения и публикует актуальный набор.
- если scheduled-публикация упала после Telegram retry, сервис пробует еще раз через 5 минут; если повтор тоже не прошел, уведомляет администратора через `TELEGRAM_ADMIN_CHAT_ID`, если он задан.
- активный social-пост с `PHOTOS` file id без URL сохраняется как `failed`, а не публикуется text-only.
- webhook security пока остается простой: достаточно сделать рабочий trusted webhook path без IP allowlist/request signature.
- preferred production photo mapping is `body.all_properties.PHOTOS` as an array of `{ id, url, path }`; for this payload shape no Bitrix file resolver is needed.
- admin notification target is `TELEGRAM_ADMIN_CHAT_ID=609150103`, configured through env.

## 2026-06-05 / Closed for Telegram Release

- Raw `all_properties.PHOTOS: "253902"` remains supported as an optional
  fallback through `BITRIX_FILE_RESOLVER_URL`. The primary release payload is
  still the URL-bearing `{ id, url, path }` array, and that shape does not need a
  resolver.
- The resolver source is a Bitrix-side HTTP endpoint. The service calls it with
  `POST { "ids": ["253902"] }` and expects
  `{ "photos": [{ "id", "url", "path" }] }`.
- `TELEGRAM_ADMIN_CHAT_ID=609150103` is documented as env and not hardcoded.
- First release remains Telegram-only, single Node process, SQLite in
  `./data/bitrix-tg.sqlite`, and deterministic text fitting only.

## Критично для старта

1. Решено для релиза: если future payload снова пришлет только `all_properties.PHOTOS: "253902"` вместо массива `{ id, url, path }`, сервис вызывает Bitrix resolver через `BITRIX_FILE_RESOLVER_URL`, если он настроен; если resolver не настроен или URL не получен, пост остается `failed` и админ уведомляется.
2. Нужно ли записать `TELEGRAM_ADMIN_CHAT_ID=609150103` также в локальный production `.env` на сервере вручную, или deployment будет задавать env другим способом?
3. Если `active_from` приходит только датой без времени, сервис теперь блокирует публикацию и уведомляет админа. Нужно ли дополнительно отправлять такое уведомление при каждом повторном webhook или достаточно первого уведомления на один payload hash?
4. Какой Telegram-чат или канал является целевым: один фиксированный `chat_id` из env или в будущем значение `pub_news_social` должно выбирать направление?

## Редактирование и медиа

5. Если раньше был текст без фото, а затем добавили фото, фото должно отправляться отдельным сообщением после текста. Это поведение подходит?
6. Если caption не влезает в 1024 символа, нужно ли отправлять короткий caption плюс продолжение отдельным текстовым сообщением, или всегда сжимать до одного caption?
7. Нужно ли сохранять порядок фотографий строго как в Битрикс?

## Telegram и формат

8. Нужен ли `parse_mode`: plain text, HTML или MarkdownV2?
9. Нужны ли inline-кнопки? Ссылку на сайт сейчас решено не добавлять.
10. Нужно ли публиковать в тему форума Telegram через `message_thread_id`?

## ИИ

11. Какой AI-провайдер использовать для подгонки текста?
12. Разрешено ли ИИ сокращать заголовок `name`, или заголовок должен оставаться неизменным?
13. Нужно ли логировать исходный и финальный текст для ручной проверки?

## Надежность

14. Нужно ли импортировать уже опубликованные посты из n8n-таблицы, если она существует?
