---
title: "Журнал wiki"
created: 2026-06-04
tags:
  - bitrix
  - telegram
  - log
---

# Журнал wiki

## [2026-06-04 10:15+03:00] ingest | Первичное ТЗ по постеру Битрикс

Добавлены страницы проекта: обзор, контракт вебхука, бизнес-правила, модель данных, Telegram-публикация, подгонка текста через ИИ, отложенная публикация, открытые вопросы и граф связей.

Ключевое открытие: для альбомов Telegram и сценария "к старому текстовому посту добавили фото" недостаточно хранить только `bitrix_id`, `tg_message_id` и `chat_id` в одной таблице. Нужна таблица отдельных Telegram-сообщений или другой механизм хранения нескольких `message_id`.

## [2026-06-04 13:36+03:00] milestone | Pending cancellation и webhook security

Обновлены правила для `active != "Y"` и пустого `pub_news_social`: если пост еще не опубликован и не имеет Telegram-сообщений, отложенная публикация отменяется через `ignored`; если пост уже опубликован, Telegram не трогается. В коде также добавлено constant-time сравнение `WEBHOOK_SECRET`, а тесты расширены до сценариев отмены scheduled-поста, inactive для опубликованного поста и успешного shared-secret webhook.

## [2026-06-04 13:51+03:00] milestone | Telegram retry и log redaction

Добавлен retry wrapper для Telegram Bot API: повторяются только network/`429`/`5xx`, постоянные `4xx` не повторяются. Настройки вынесены в `TELEGRAM_RETRY_ATTEMPTS` и `TELEGRAM_RETRY_DELAY_MS`. Серверный logger получил redaction paths для `x-webhook-secret` и `authorization`. Тесты расширены до transient/permanent Telegram retry, retry stuck `publishing` rows, retry env config и log-redaction config.

## [2026-06-04 14:06+03:00] milestone | Redaction ошибок перед last_error

Добавлена общая утилита `redactSensitiveText`: она редактирует Telegram bot-token, `authorization`, `x-webhook-secret`, `TELEGRAM_BOT_TOKEN` и `WEBHOOK_SECRET` в текстах ошибок. Telegram client применяет ее к API/network errors, а orchestrator и scheduler - перед возвратом failed result и сохранением `last_error`. Тесты расширены до 45 проверок в 9 файлах; `npm test` и `npm run build` прошли.

## [2026-06-04 14:20+03:00] milestone | Redaction unhandled error logs

Усилена redaction для JSON-style значений headers/env и добавлен `redactErrorForLog`, который очищает message и stack перед логированием неожиданных ошибок. Webhook route теперь возвращает generic `internal_error` на unhandled сбои и логирует только redacted object; scheduler outer catch и startup console error также используют redacted error output. Добавлены тесты для JSON-style redaction, safe Error log output и generic webhook 500 response.

## [2026-06-04 14:45+03:00] discovery | Production payload и решения по правилам

Получен sanitized production-shaped payload: поле начала активности приходит как lowercase `active_from` (`11.06.2026`), `pub_news_social` означает "любое непустое значение = публиковать", ссылки в Telegram не добавляем. Production-решения: при `active=N` удалять уже опубликованные Telegram-сообщения; при удалении фото в Битрикс удалять фото из Telegram; failed scheduled rows пробовать автоматически еще раз через 5 минут, затем уведомлять администратора. Новый blocker: `all_properties.PHOTOS` пришел как Bitrix file id string (`253902`) без URL, а Telegram не может отправить такой id напрямую. Добавлен sanitized sample `samples/bitrix-production-webhook-sanitized.json`.

## [2026-06-04 15:05+03:00] milestone | Production safety для фото, deletion и scheduled retry

Реализована безопасная обработка `PHOTOS` file id без URL: parser сохраняет unresolved id, а активный social-пост получает `failed` до Telegram-вызовов, чтобы не публиковать неполный text-only пост. Для `active=N` уже опубликованные Telegram-сообщения удаляются, refs очищаются из базы, а строка становится `ignored`. Default media sync переведен на `rebuild`, чтобы удаленные в Битрикс фото удалялись из Telegram; `soft` оставлен как явная настройка. Scheduled worker теперь делает один автоматический retry через 5 минут и после повторной ошибки может уведомить администратора через `TELEGRAM_ADMIN_CHAT_ID`.

## [2026-06-04 16:26+03:00] milestone | Production PHOTOS array mapping

Получены новые данные от production/n8n: основной желаемый источник фото - `body.all_properties.PHOTOS` как массив `{ id, url, path }`. Для такого payload Bitrix file resolver не нужен; envelope-level `photo_urls`, `photo_url`, `has_photo` считаются вспомогательными. Добавлен sanitized sample `samples/bitrix-production-photos-array-sanitized.json`, тесты parser/process/Telegram client для сохранения массива фото, inactive no-publish, удаления опубликованного media group при `active=N`, публикации active media group и URL encoding пробелов. `.env.example` теперь содержит `TELEGRAM_ADMIN_CHAT_ID=609150103`.

## [2026-06-05 09:15+03:00] milestone | Exact active_from time required

Уточнено production-правило по времени публикации: если `active_from` найден, но содержит только дату без точного времени, пост не отправляется. Parser теперь сохраняет `scheduledAtPrecision` и `scheduledAtRawValue`; orchestrator переводит active/social date-only payload в `failed`, не вызывает Telegram publish и вызывает admin notifier. Значение вроде `11.06.2026 00:05:00` считается точным временем. Sanitized production sample обновлен до актуального `active_from: "11.06.2026 00:05:00"`.

## [2026-06-05 09:40+03:00] milestone | Bitrix photo id resolver for release

Добавлен опциональный Bitrix photo resolver для payload, где
`body.all_properties.PHOTOS` приходит как file id вроде `"253902"`. Основной
production payload с URL-bearing массивом `{ id, url, path }` resolver не требует.
Если `BITRIX_FILE_RESOLVER_URL` задан, сервис вызывает его через
`POST { "ids": [...] }`, ожидает `{ "photos": [{ "id", "url", "path" }] }` и
сохраняет resolved `{ id, url, path }`. Если URL получить не удалось, Telegram
publish/edit не вызывается, пост получает `failed`, и админ уведомляется через
`TELEGRAM_ADMIN_CHAT_ID`, если notifier настроен. Scheduled worker использует тот
же resolver для совместимости со старыми scheduled rows.
## [2026-06-05 12:57+03:00] milestone | Telegram multipart photo fallback

Telegram photo delivery is now more robust for production Bitrix URLs. The
client still tries encoded HTTPS URLs first, but when Telegram rejects a photo
URL with an HTTP URL content/media error, the service downloads the image itself
and retries through multipart upload. This covers `sendPhoto`, `sendMediaGroup`,
and `editMessageMedia`; media groups use `attach://photo_N` references. The
fallback cannot fix missing URLs, unreachable image hosts from the `bitrix-tg`
server, invalid image files, or Telegram file-size/type limits, but it removes
Telegram-side URL fetching as a single point of failure. Verification:
`npm test` passed 79 tests in 10 files and `npm run build` passed.
