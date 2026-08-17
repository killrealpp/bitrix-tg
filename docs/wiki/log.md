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

## [2026-06-26 18:40+03:00] milestone | Telegram + VK + MAX multi-social layer

The service now accepts canonical Bitrix fields `publish_social`,
`publish_targets`, `post_type`, and diagnostic `property_meta`. The master
social checkbox controls all targets. Telegram keeps edit/rebuild behavior,
while VK and MAX are publish/delete only for the first multi-social release.

At this milestone, OpenRouter gained SMM preparation prompts for `event`,
`promo`, and `company_news` posts with a 1000-character target. This was later
replaced by the 2026-07-15 client prompt set with `product_new` and a
1200-character target. The database has a new `social_publications` table for
target-level state and new `bitrix_posts` fields for `post_type`, selected
targets, and prepared text.

MAX publishing sends public image URLs as message attachments. VK publishing
uploads wall photos with `VK_ACCESS_TOKEN` and posts to the group wall with
`VK_TOKEN`. The internal scheduler publishes all selected targets together.

Verification: `npm run build` passed and `npm test` passed 145 tests in 14
files.

## [2026-06-30 17:45+03:00] milestone | Bitrix section fallback for post type

Production Bitrix payload showed `iblock_name: "Новости"` while the actual
content section was expected to be `События`. The Bitrix `init.php` template
now sends `section_id`, `section_name`, `section_code`, and
`iblock_section_name`, and uses the section name as `post_type` when a dedicated
post-type property is absent. The parser also accepts the real production target
property codes `pub_news_tg` and `pub_news_vkpost`.

The public Bitrix debug payload file is disabled in the production template.
`docs/bitrix/update-init-command.php.txt` is a paste-ready Bitrix PHP command
that updates `/local/php_interface/init.php`, creates a timestamped backup, and
removes the old `/local/bitrix_tg_last_payload.json` file if it exists.

Verification: `npm test` passed 148 tests in 14 files and `npm run build`
passed.

## [2026-06-30 18:35+03:00] milestone | Scheduled partial target retry safety

Production scheduled multi-social run showed Telegram could be sent before a
VK/MAX failure caused the whole due post to be marked failed for retry. The
scheduled worker now persists successful Telegram refs immediately, reuses them
on retry, records failed external target state separately, and retries only
missing external targets. This prevents duplicate Telegram sends when VK or MAX
fails after Telegram has already accepted the post.

Verification: `npm test` passed 149 tests in 14 files and `npm run build`
passed.

## [2026-06-30 18:40+03:00] milestone | Immediate external partial publish safety

The same partial-target rule now applies to immediate/re-save processing:
if VK publish fails, MAX is still attempted and successful MAX state is saved.
The overall post result remains failed so the VK error is visible, but one
external target can no longer block another target from publishing.

Verification: `npm test` passed 150 tests in 14 files and `npm run build`
passed.

## [2026-07-01 11:45+03:00] milestone | VK photos_list upload and MAX fetch diagnostics

Production VK photo publishing reached `photos.saveWallPhoto` and failed with
`photos_list is invalid`. The VK client now accepts both upload response shapes:
`photo` and `photos_list`, then passes the available payload to
`photos.saveWallPhoto`.

MAX failures previously collapsed to the unhelpful `fetch failed`. MAX client
network errors now include the operation path (`/uploads`, upload URL, or
`/messages`) while still redacting the bot token, so the next production retry
will show where the MAX request actually fails.

Verification: `npm test` passed 152 tests in 14 files and `npm run build`
passed.

## [2026-07-01 11:58+03:00] milestone | VK upload response diagnostics

Production retry still reached `photos.saveWallPhoto`, which means the new
server-bound VK token is accepted, but VK rejected the uploaded photo payload as
invalid. The VK client now validates wall upload responses before
`photos.saveWallPhoto` and records a compact diagnostic summary when save fails:
whether `server` and `hash` were present, which payload field was returned
(`photo` or `photos_list`), and the payload length. This keeps tokens out of logs
while making the next production retry actionable.

Verification: `npm test` passed 154 tests in 14 files and `npm run build`
passed.

## [2026-07-01 13:02+03:00] milestone | MAX image URL attachments

Production MAX reached image upload after the server CA fix, but `/uploads`
returned no usable token for the image flow. The current MAX docs allow images
to be attached by direct external URL in `attachments.payload.url`, so MAX image
publishing now uses encoded Bitrix photo URLs directly and skips `/uploads` for
images. VK and Telegram remain unchanged.

Verification: `npm test` passed 155 tests in 14 files and `npm run build`
passed.

## [2026-07-01 13:16+03:00] milestone | Format-only AI prompt for other post types

The text preparation rule was corrected: `entertainment`, `unknown`, and any
other non-business post type should still call OpenRouter when configured, but
with a format-only prompt. This prompt must preserve the original meaning and
facts, avoid turning the text into an event/promo/company-news post, and only add
light structure plus 1-3 relevant emoji. If AI is unavailable, deterministic
fallback formatting treats unknown types as light/entertainment-style content.

Regression coverage now proves that all post types call `aiPrepare`, unknown
types use the format-only OpenRouter prompt, and an unknown multi-photo post is
published to Telegram/VK/MAX with the prepared text and all photos.

Verification: `npm test` passed 159 tests in 14 files and `npm run build`
passed.

## [2026-07-15 12:00+03:00] milestone | Client SMM prompts for Telegram and MAX

The active SMM prompt text now lives in `src/text/socialPrompts.ts`. The service
uses the client-approved templates for `promo`, `company_news`, `event`, and
`product_new`, while `entertainment`/`unknown` keep the format-only prompt.
`Новинки` is now normalized to `product_new` so product arrivals use the
"Новинка товара" rules instead of the company-news rules.

VK publication remains disabled. Prompt-level platform rules tell the AI that
one prepared post is shared by Telegram and MAX, so it must not choose the VK
CTA as the primary call to action. The shared AI preparation target is now 1200
characters to match the supplied templates.

## [2026-07-01 15:02+03:00] milestone | VK photo upload transient retry

Production scheduled post `181846` published to Telegram and MAX with two
photos, but the overall row stayed `failed` because VK photo upload returned
HTTP `504`. The VK client now retries transient wall photo upload failures:
network errors, HTTP `429`, and HTTP `5xx`. Permanent upload failures such as
HTTP `400` still fail immediately.

Verification: `npm test` passed 161 tests in 14 files and `npm run build`
passed.

## [2026-07-01 15:18+03:00] milestone | VK empty upload payload retry

Production retry for post `181846` then reached VK upload successfully, but the
upload server returned an empty photo payload (`photo=[]`) even though `server`
and `hash` were present. Telegram and MAX had already published the same
two-photo post, so the fix is VK-only: empty or missing VK upload payload fields
now retry the whole wall-photo upload cycle with a fresh `photos.getWallUploadServer`
URL before failing.

Verification: `npx vitest run tests/vkClient.test.ts --reporter=verbose` passed
10 tests, `npm test -- --reporter=dot` passed 162 tests in 14 files, and
`npm run build` passed.

## [2026-07-01 15:25+03:00] milestone | VK manual multipart photo upload

Post `181846` still received VK `photo=[]` after retrying with a fresh upload
server, while Telegram and MAX had already published the same two-photo post.
This points to VK not recognizing the multipart file body rather than a queue or
target-selection bug. VK photo upload now sends a manually assembled multipart
body with explicit `Content-Type` boundary and `Content-Length`, preserving the
`photo` field name required by VK. If VK still returns an empty upload payload,
the stored error will also include downloaded file diagnostics: byte size,
content type, and filename, without exposing any URL or token.

Verification: `npx vitest run tests/vkClient.test.ts --reporter=verbose` passed
10 tests, `npm test -- --reporter=dot` passed 162 tests in 14 files, and
`npm run build` passed.

## [2026-08-17 16:15+03:00] milestone | Public URL only, and duplicate-safe post creation

Published posts contained `Подробнее:
/bitrix/admin/iblock_element_edit.php?IBLOCK_ID=151&ID=181892`. The Bitrix
`init.php` payload carries both the admin edit link as `url` and the public
detail page as `public_url`, and the parser read `url` first while `public_url`
was not in the alias list at all. Four posts and eight social publications had
already shipped the admin link to Telegram and MAX.

The parser now resolves the source link through `pickPublicUrl`, which tries
`public_url`, then `detail_page_url`, then `url`, and rejects any candidate
matching `/bitrix/(admin|tools)/`. When no public link survives, the AI prompt
explicitly instructs the model to drop the «Подробнее» item instead of inventing
an address.

`SqliteGateway.createPost` no longer fails the request when two overlapping
webhooks for one element race to insert: the loser detects the
`bitrix_posts.bitrix_id` unique violation and reuses the winner's row. This was
observed on 2026-08-06 as an unhandled `SQLITE_CONSTRAINT` returning HTTP 500,
and reproduced again on 2026-08-17 when one element arrived three times in under
a minute.

Also on the Bitrix side: the handler read the element through
`CIBlockElement::GetList` without `CHECK_PERMISSIONS => "N"`, and `init.php`
existed only under the `svarka40.com` document root, so editors working in the
`b24.svarnoy.org` admin never registered the event handler and their posts never
produced a webhook. A loader in `/home/bitrix/www/local/php_interface/init.php`
now requires the shared file.

Verification: `npm test` passed 189 tests in 15 files, `npm run build` passed,
and a synthetic webhook carrying an admin `url` plus a public `public_url`
produced post text containing only `https://svarnoy-market.ru/news/999000777/`.
