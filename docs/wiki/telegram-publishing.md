---
title: "Telegram-публикация"
created: 2026-06-04
tags:
  - telegram
  - bot-api
  - publishing
---

# Telegram-публикация

Сервис должен работать через Telegram Bot API. По официальной документации Bot API текст в `sendMessage` ограничен 1-4096 символами после парсинга сущностей, а caption у медиа ограничен 0-1024 символами после парсинга сущностей.

Источник: https://core.telegram.org/bots/api

## Методы для новых публикаций

Для поста без фото используется `sendMessage`.

Для поста с одной фотографией используется `sendPhoto`. Текст идет в `caption`.

Для поста с несколькими фотографиями используется `sendMediaGroup`. Caption нужно прикреплять к первому элементу альбома, если выбран такой формат публикации.

## Методы для редактирования

Для текстового сообщения используется `editMessageText`.

Для изменения caption используется `editMessageCaption`.

Для замены одиночного медиа используется `editMessageMedia`.

Для сложных изменений альбома возможны две политики:

- мягкая синхронизация: редактировать существующие элементы по индексам, досылать новые фото, старые лишние удалить;
- жесткая синхронизация: удалить старый набор сообщений и отправить новый набор.

Политика должна быть выбрана до реализации, потому что она влияет на пользовательский опыт в канале и на модель данных.

2026-06-04 / текущая production-реализация: если список фото изменился, default-политика `rebuild` удаляет старые media-сообщения через `deleteMessage` и публикует актуальный набор заново. Это покрывает production-решение "если фото удалили в Битрикс, удалить их из Telegram". Мягкий режим остается доступен только через явное `TELEGRAM_MEDIA_SYNC_POLICY=soft`.

## Фото из Битрикс

В примере фото приходит как URL вида `https://svarnoy-market.ru/upload/.../2026-01-15 19.47.41.jpg`. В URL есть пробелы, поэтому реализация должна безопасно кодировать URL или скачивать файл и отправлять его multipart-загрузкой.

Рекомендуемый стартовый вариант: сначала пробовать отправлять Telegram прямой HTTPS URL после корректного URL-encoding. Если Telegram возвращает ошибку загрузки, сервис должен скачать файл сам и отправить как файл. Это поведение нужно логировать.

2026-06-04 / production sample: вместо URL фото пришел только Bitrix file id (`PHOTOS: "253902"`). Такой id не является Telegram file id и не является публичным HTTPS URL. Нужен URL в payload или Bitrix file resolver до реальной публикации фото.

2026-06-04 / текущая реализация safety: сервис распознает Bitrix file id без URL как unresolved photo и не передает его в Telegram. Активный social-пост с unresolved-фото получает `failed` с ошибкой о необходимости URL mapping или Bitrix file resolver.

2026-06-04 / production photo mapping update: the desired n8n payload now sends `body.all_properties.PHOTOS` as `[{ id, url, path }, ...]`. For this URL-bearing shape, Telegram publication can use the `url` directly after URL encoding; a Bitrix file resolver is not needed. Tests now cover media-group publication from this array and encode spaces in URLs as `%20` before the Telegram API call.

## Форматирование текста

Если используется HTML или Markdown-разметка, лимит Telegram считается после парсинга сущностей. Поэтому подгонка текста должна работать с учетом выбранного `parse_mode`. Если форматирование не критично, самый надежный стартовый вариант - отправлять plain text без `parse_mode`.

## Retry и ошибки Telegram

2026-06-04 / текущая реализация: клиент Telegram повторяет только временные ошибки: сетевые сбои, HTTP `429` и HTTP `5xx`. Количество попыток задается через `TELEGRAM_RETRY_ATTEMPTS` (default `3`), базовая пауза через `TELEGRAM_RETRY_DELAY_MS` (default `500`). Для `429` используется `retry_after`, если Telegram его вернул.

Постоянные ошибки уровня `400`, `401`, `403` и `404` не повторяются, потому что обычно означают неверный payload, token, chat id или права бота. После исчерпания retry публикация или редактирование помечает строку `bitrix_posts` как `failed` и сохраняет `last_error`. Повторный вебхук с тем же нормализованным payload может переиспользовать такую строку и снова попробовать публикацию.

Перед выбросом ошибки клиент редактирует bot-token и header-like значения вроде `authorization`. Дополнительно orchestration/scheduler редактируют secret-shaped значения перед сохранением `last_error`.

Неожиданные серверные ошибки вне обычного Telegram failure path логируются через redacted message/stack, чтобы token/header-like значения не утекали через Fastify error logs, scheduler outer catch или startup console output.

## Связанные страницы

- [[business-rules]]
- [[ai-text-fitting]]
- [[data-model]]

## 2026-06-05 / Bitrix File Resolver Before Telegram

Telegram publication never receives raw Bitrix file ids. URL-bearing
`body.all_properties.PHOTOS` objects are sent directly after URL encoding and do
not require `BITRIX_FILE_RESOLVER_URL`. Raw file ids such as `"253902"` are first
resolved through `BITRIX_FILE_RESOLVER_URL` only when that optional fallback is
configured.

If photo resolution still leaves any item without a URL, the publish/edit path
stops before `sendPhoto`, `sendMediaGroup`, or `editMessageMedia`. The post is
stored as `failed` and the admin notification path is used so the operator can
fix the Bitrix resolver or the incoming payload mapping.

## 2026-06-05 / Multipart Photo Upload Fallback

For URL-bearing Bitrix photos, the Telegram client keeps the fast path first:
`sendPhoto`, `sendMediaGroup`, and `editMessageMedia` receive the encoded HTTPS
URL. If Telegram rejects that request with an HTTP URL content/media error, the
service downloads the image itself from the encoded URL and retries the same
Telegram method as multipart upload.

For albums, the fallback downloads every photo and sends `sendMediaGroup` with
`attach://photo_N` media references. For media replacement, the fallback sends
`editMessageMedia` with a multipart `media` JSON object and one attached file.
This improves production reliability for URLs with spaces or hosts that Telegram
cannot fetch directly, as long as the `bitrix-tg` server itself can download the
image and the file is valid for Telegram.

## 2026-06-05 / Photo Delivery Mode

Production default is now `TELEGRAM_PHOTO_DELIVERY_MODE=upload`. In this mode,
URL-bearing Bitrix photos are always downloaded by the service first and then
uploaded to Telegram as files. This avoids depending on Telegram's ability to
fetch `svarnoy-market.ru` photo URLs directly.

Supported modes:

- `upload` - download from Bitrix URL on the service host and upload multipart
  to Telegram.
- `auto` - try encoded URL first, then upload multipart when Telegram reports a
  URL-fetch/media error.
- `url` - only pass encoded URLs to Telegram; mostly useful for debugging.

If photos still fail under `upload`, the next suspects are service-host network
access to the image URL, invalid/empty image responses, Telegram size/type
limits, or unresolved Bitrix file ids without URLs.
