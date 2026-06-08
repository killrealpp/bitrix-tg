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

## [2026-06-05 13:21+03:00] milestone | Upload-first photo delivery

The production default is now `TELEGRAM_PHOTO_DELIVERY_MODE=upload`: the service
downloads URL-bearing Bitrix photos and uploads them to Telegram as multipart
files without first asking Telegram to fetch the URL. `auto` keeps URL-first
behavior with multipart fallback, and `url` keeps URL-only behavior for
debugging. Webhook processing now logs each failed `bitrixId` with a redacted
error so photo failures are visible in `journalctl`. Verification: `npm test`
passed 82 tests in 10 files and `npm run build` passed.

## [2026-06-05 13:50+03:00] milestone | Broad Bitrix photo parsing

Photo detection was broadened before Telegram delivery. The parser now accepts
lowercase and uppercase photo fields (`url`/`URL`, `src`/`SRC`, `id`/`ID`,
`FILE_ID`), Bitrix property wrappers such as `VALUE`, numeric object maps,
JSON-string photo arrays, comma-separated file ids, and
`preview_picture`/`detail_picture` fallback fields. The webhook route logs
`Bitrix event parsed` with `photoCount`, `photoIds`, and
`unresolvedPhotoCount`, so production logs show whether photos were recognized
before publishing. Verification: `npm test` passed 90 tests in 10 files and
`npm run build` passed.

## [2026-06-05 14:25+03:00] milestone | Scheduled photo E2E and Bitrix local time

Scheduling now treats Bitrix date strings without explicit timezone as Bitrix
local time via `BITRIX_LOCAL_UTC_OFFSET_MINUTES=180`, instead of depending on
the VPS process timezone. Production exact-time enforcement is wired through the
webhook route with `BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true`: missing, date-only,
or invalid activity time fails active social posts before Telegram and can
notify the admin.

The scheduler now logs non-empty worker results. Verification: `npm test`
passed 97 tests in 10 files, `npm run build` passed, and a real local Telegram
E2E passed with two local URL photos containing spaces: scheduled store,
upload-first `sendMediaGroup`, album caption edit, photo-removal rebuild to
text, and inactive cleanup deletion all succeeded without printing secrets.

## [2026-06-08 11:15+03:00] milestone | Rebuild media sync for text/mixed edits

Production `rebuild` media sync now applies to text and old mixed posts too.
When a Bitrix element gains photos after a text-only Telegram publication, or an
old mixed text-plus-extra-photo publication changes/removes photos, the service
deletes every Telegram message stored for that Bitrix element and republishes
the current canonical state (`sendMessage`, `sendPhoto`, or `sendMediaGroup`).
This avoids the previous soft-style symptom where removed photos stayed visible
and added photos appeared as separate extra messages.

Regression coverage now includes text->media_group, mixed->media_group,
mixed->text, the existing soft behavior when explicitly configured, and multiple
due scheduled posts being published in one worker run. Verification:
`npm test` passed 111 tests in 10 files and `npm run build` passed.

## [2026-06-08 11:45+03:00] milestone | OpenRouter text fitting

AI text fitting is now wired for the release through OpenRouter. The service
checks Telegram limits first: short text is published unchanged and does not
call AI; only over-limit text or captions call the configured OpenRouter chat
completion model. `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` are the primary env
settings, while legacy `OPENAI_API_KEY`/`OPENAI_MODEL` still work as fallbacks
for the user's existing ignored `.env`.

If OpenRouter fails, returns empty text, or returns text that still exceeds
Telegram limits, the publication continues with deterministic truncation.
Verification: `npm test` passed 119 tests in 11 files and `npm run build`
passed.
