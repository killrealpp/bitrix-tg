# Build the Bitrix-to-Telegram Poster Service

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This repository did not contain a checked-in `PLANS.md` file when this plan was created. The plan follows the external `PLANS.md` supplied by the user and is self-contained so a new contributor can implement from this file alone.

## Purpose / Big Picture

After this change, a content manager will be able to edit a news element in Bitrix and have the matching Telegram post created or updated automatically. The service will receive Bitrix webhook payloads, ignore inactive or non-social elements, normalize photos, fit text to Telegram limits, publish at the element's activity start time, and store enough database state to avoid duplicates and support later edits.

The behavior is visible end to end: send a sample webhook with `active: "Y"` and non-empty `pub_news_social`, observe a Telegram message appear in the configured chat, then send another webhook with the same `element_id` and changed text or photos and observe the existing Telegram publication update instead of duplicating.

## Progress

- [x] (2026-06-04 10:15+03:00) Captured the initial product requirements from the user's n8n workflow description.
- [x] (2026-06-04 10:15+03:00) Created an Obsidian-style wiki under `docs/wiki` with the detailed requirements, graph, and open questions.
- [x] (2026-06-04 12:10+03:00) Verified Ruflo project setup, MCP availability, daemon status, and memory/RAG backend before implementation.
- [x] (2026-06-04 12:27+03:00) Confirmed the implementation stack for the MVP: Node.js, TypeScript, Fastify, SQLite, direct Telegram Bot API calls, and optional AI-only text fitting.
- [x] (2026-06-04 12:27+03:00) Scaffolded the service, configuration, database migration, Telegram client interface, fake test clients, and test tooling.
- [x] (2026-06-04 12:27+03:00) Implemented webhook parsing, active/social filtering, `PHOTOS` normalization, stable payload hashing, and idempotency tests.
- [x] (2026-06-04 12:31+03:00) Added controlled-clock scheduled publishing tests, text fitting tests, webhook secret tests, and SQLite migration tests.
- [x] (2026-06-04 12:48+03:00) Configured a local ignored `.env` with Telegram credentials, validated `getMe` and `getChat`, and started the dev server against the real Telegram test channel.
- [x] (2026-06-04 12:51+03:00) Validated real Telegram text publish, text idempotency, text edit, photo publish, photo idempotency, media-group publish, and media-group idempotency.
- [x] (2026-06-04 13:05+03:00) Implemented robust Bitrix activity-start parsing for `ACTIVE_FROM`, `DATE_ACTIVE_FROM`, lower-case aliases, nested/configured paths, ISO dates, and Bitrix `DD.MM.YYYY HH:MM:SS` dates.
- [x] (2026-06-04 13:05+03:00) Improved Telegram source text assembly from real Bitrix field aliases (`NAME`, `PREVIEW_TEXT`, `DETAIL_TEXT`) with basic HTML/entity normalization and duplicate paragraph removal.
- [x] (2026-06-04 13:05+03:00) Implemented the default soft media edit policy in code and fake-Telegram tests: edit captions only when changed, edit single media or album items by index where possible, append newly added album photos as extra messages, and edit mixed text-plus-photo posts through the original text message.
- [x] (2026-06-04 13:20+03:00) Validated real Telegram soft media flows against the test channel: single-photo `editMedia`, album item `editMedia`, appended extra photo, album shrink no-op under `soft`, and cleanup deletion of all created test messages.
- [x] (2026-06-04 13:22+03:00) Added regression tests for soft photo shrink, rebuild deletion after photo removal, `BITRIX_ACTIVE_FROM_FIELD` env loading, and configured active-start parsing through the webhook route.
- [x] (2026-06-04 13:36+03:00) Hardened pending-post filtering and webhook authentication: inactive/non-social updates now cancel not-yet-published scheduled rows, already published posts remain untouched, and shared-secret comparison uses `timingSafeEqual`.
- [x] (2026-06-04 13:51+03:00) Added Telegram Bot API transient retry settings, request-log redaction for webhook secrets, and regression coverage for stuck `publishing` rows.
- [x] (2026-06-04 14:06+03:00) Added defensive redaction for secret-shaped values in Telegram errors, orchestration failures, and scheduled `last_error` persistence.
- [x] (2026-06-04 14:20+03:00) Closed the remaining logging/error-surface redaction gap for unhandled webhook errors, scheduler outer failures, startup console errors, and JSON-style header/env secret strings.
- [x] (2026-06-04 14:45+03:00) Captured production decisions from a real Bitrix/n8n payload: use lowercase `active_from`, publish on any non-empty `pub_news_social`, do not append links, delete Telegram messages on `active=N`, delete removed Bitrix photos from Telegram, retry failed scheduled posts once after 5 minutes before admin notification, and keep webhook security simple for now.
- [x] (2026-06-04 15:05+03:00) Implemented the production safety milestone: parser preserves unresolved Bitrix `PHOTOS` file ids, active/social unresolved-photo payloads fail instead of publishing text-only, published posts are deleted from Telegram on `active=N`, default media sync is now `rebuild`, scheduled posts retry once after 5 minutes, and final scheduled failure can notify `TELEGRAM_ADMIN_CHAT_ID`.
- [x] (2026-06-04 16:26+03:00) Captured the preferred production/n8n photo mapping: `body.all_properties.PHOTOS` is an array of `{ id, url, path }` objects, envelope-level `photo_urls`/`photo_url`/`has_photo` are only auxiliary, URL spaces must be encoded before Telegram calls, `TELEGRAM_ADMIN_CHAT_ID=609150103` is the admin notification env value, and the default SQLite path remains `./data/bitrix-tg.sqlite`.
- [x] (2026-06-05 09:12+03:00) Tightened `active_from` scheduling safety: when Bitrix sends an activity-start field with only a date and no exact time, active/social posts are marked `failed`, no Telegram publication is attempted, and the admin notifier is called via the configured admin destination.
- [x] (2026-06-05 09:40+03:00) Implemented the optional Bitrix photo resolver fallback: raw `PHOTOS` file ids call `BITRIX_FILE_RESOLVER_URL` when configured, URL-bearing arrays skip the resolver, unresolved results fail before Telegram and notify the admin, and the scheduled worker uses the same resolver for old scheduled rows.
- [x] (2026-06-05 12:57+03:00) Hardened Telegram photo delivery: `sendPhoto`, `sendMediaGroup`, and `editMessageMedia` first try encoded HTTPS URLs, then fall back to downloading each Bitrix photo from the service host and uploading it to Telegram through multipart when Telegram reports an HTTP URL fetch/media error.
- [x] (2026-06-05 13:21+03:00) Switched the production default photo delivery mode to service-side upload via `TELEGRAM_PHOTO_DELIVERY_MODE=upload`; URL-first behavior remains available as `auto` or `url`, and failed webhook processing now writes a redacted per-`bitrixId` warning to the service log.
- [x] (2026-06-05 13:50+03:00) Fixed photo detection before Telegram: parser now recognizes Bitrix/PHP photo variants with `URL`, `SRC`, `ID`, `FILE_ID`, `VALUE` wrappers, numeric object maps, JSON-string photo arrays, comma-separated file ids, and `preview_picture`/`detail_picture` fallbacks. Webhook logs now include `photoCount`, `photoIds`, and `unresolvedPhotoCount` for every parsed event.
- [x] (2026-06-05 14:25+03:00) Fixed production scheduling time semantics: Bitrix local date strings without explicit timezone are parsed with `BITRIX_LOCAL_UTC_OFFSET_MINUTES=180`, `BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true` blocks active/social posts without an exact time, invalid time values preserve source details for admin notifications, and the scheduler logs non-empty worker results.
- [x] (2026-06-08 11:15+03:00) Tightened production `rebuild` media sync for text/mixed posts: when photos are added to a text post or changed/removed from an old mixed post, the service deletes all Telegram messages for that Bitrix element and republishes the current text/photo state. Added regression coverage for text->media_group, mixed->media_group, mixed->text, and multiple due scheduled posts in one worker run.
- [x] (2026-06-08 11:45+03:00) Added OpenRouter-backed AI text fitting: short texts bypass AI, over-limit text/captions call OpenRouter through `OPENROUTER_*` env, legacy `OPENAI_*` env remains a fallback, and AI failure or too-long AI output falls back to deterministic truncation.
- [x] (2026-06-26 18:40+03:00) Added the multi-social layer for canonical Bitrix fields `publish_social`, `publish_targets`, `post_type`, and `property_meta`; Telegram retains edit/rebuild, VK/MAX publish/delete only, OpenRouter prepares event/promo/company-news posts, SQLite stores per-target `social_publications`, and fake-client coverage verifies Telegram/VK/MAX scheduling, idempotency, target enable/disable, and client photo flows.
- [x] (2026-07-01 13:02+03:00) Switched MAX image publication from `/uploads?type=image` token flow to direct public image URL attachments (`attachments.payload.url`) after production showed image upload responses without a usable token and the current MAX docs confirmed URL attachments for images.
- [x] (2026-07-06 18:08+03:00) Diagnosed production logs for Bitrix element `181848`: `post_type: "Новинки"` now maps to the company-news AI prompt, AI preparation fallback is logged, and scheduled VK/MAX/TG partial failures emit per-post diagnostic logs instead of only aggregate `failed:1`.
- [x] (2026-07-07 09:00+03:00) Added explicit AI preparation diagnostics: OpenRouter success logs now include `bitrixId`, `postType`, input/output length, target, truncation flag, and duration; empty AI responses are reported before deterministic fallback.
- [x] (2026-07-08 20:15+03:00) Added VK OAuth authorization endpoints, SQLite token storage, and automatic user-token refresh for VK photo upload. `/admin/vk/oauth/start` now redirects an admin through VK ID, `/admin/vk/oauth/callback` stores `access_token`, rotated `refresh_token`, `device_id`, and `expires_at`, and VK photo publishing refreshes/retries once when VK reports an invalid user access token.
- [ ] Confirm final production Telegram chat configuration after the test-channel E2E run.
- [x] (2026-06-04 12:51+03:00) Validate core Telegram publishing and text editing flows against a real Telegram test chat.
- [x] (2026-06-04 13:20+03:00) Complete real Telegram validation for complex media edit flows in the configured test channel; production still needs to confirm whether `soft` is acceptable or `rebuild` should be enabled.
- [x] (2026-06-04 12:31+03:00) Validate scheduled publishing worker with a controlled clock and database rows.
- [x] (2026-06-05 14:25+03:00) Validate end to end with sample webhook payloads and Telegram test chat.

## Surprises & Discoveries

- Observation: A single row with only `bitrix_id`, `tg_message_id`, and `chat_id` cannot represent Telegram albums or the scenario where photos are added after an existing text post.
  Evidence: Telegram `sendMediaGroup` returns multiple messages, and a text message cannot be converted into a media message. The plan therefore uses a post table plus a message table.

- Observation: The sample webhook does not include the field called "начало активности".
  Evidence: The provided JSON contains `date_create`, `date_modify`, `active`, and content fields, but no visible start-activity key. Implementation must confirm the exact key before scheduling can be finished.

- Observation: Postgres currently lives inside the n8n docker-compose environment, but the service does not actually need to depend on that database for its own publication state.
  Evidence: The user asked whether the service can create and own its own table/state "inside scripts" to be independent from n8n.

- Observation: Ruflo `memory_store`/`memory_search` and AgentDB context synthesis are separate recall paths in the current setup.
  Evidence: Project cards stored in the `bitrix-tg` memory namespace are searchable through `memory_search` with embeddings and HNSW active, while `agentdb_context_synthesize` returned no relevant memories for the same project context. Use `memory_search` as the confirmed RAG path until AgentDB recall is verified separately.

- Observation: Ruflo MCP and Ruflo CLI can show different "current swarm" views when more than one swarm exists.
  Evidence: MCP `swarm_status` for `swarm-1780564187511-63eu0u` reported 4 registered agents, while CLI `ruflo swarm status` without an explicit id showed an older empty swarm. Prefer MCP status for the active Codex-coordinated swarm in this session.

- Observation: The `sqlite` + `sqlite3` adapter installed successfully on this Windows workspace.
  Evidence: `npm install fastify zod dotenv sqlite sqlite3` completed with 0 vulnerabilities, and `tests/sqliteGateway.test.ts` verified the migration and multi-message storage on an in-memory SQLite database.

- Observation: A failed or stuck `publishing` post must be retryable even when the normalized payload hash has not changed.
  Evidence: A real photo-publishing attempt initially failed, and the existing idempotency check would have returned `unchanged` for the same failed payload. The orchestrator now returns `unchanged` only for `published` or `scheduled` rows with the same hash; failed/publishing rows retry through the publish path. Regression coverage was added.

- Observation: `tsx watch` restarts inherit the parent process environment and dotenv does not override existing variables by default.
  Evidence: The first real Telegram webhook still used the earlier dummy env after a watch restart, causing `Telegram sendMessage failed: Not Found` and writing to `./data/dev.sqlite`. Fully killing and restarting the dev process loaded all 16 variables from `.env` and used the real token/chat and `./data/dev-real.sqlite`.

- Observation: Bitrix uses `ACTIVE_FROM` as the element activity-start field in ORM/table fields, while classic API/filter examples often expose or sort by `DATE_ACTIVE_FROM`.
  Evidence: Official Bitrix docs list `ACTIVE_FROM` on `Bitrix\Iblock\ElementTable`; 1C-Bitrix API references also use `DATE_ACTIVE_FROM` for element list filters/sorting. The parser now supports both names, lower-case variants, nested `fields`/`all_properties` paths, and explicit `BITRIX_ACTIVE_FROM_FIELD`.

- Observation: No-op Telegram edits are not a safe harmless operation.
  Evidence: Telegram can reject unchanged edits with a "message is not modified" style error. The media edit path now skips `editCaption`/`editText` when the fitted text has not changed, so photo-only updates do not accidentally become failed rows.

- Observation: `mixed` posts need separate edit semantics from normal media posts.
  Evidence: A `mixed` post can mean "original text message plus later extra photos"; editing its `mainMessageId` with `editMessageCaption` would target a text message and fail. Mixed posts now update the original text via `editMessageText` and sync extra media separately.

- Observation: Telegram accepted the current `soft` media edit flow in the real test channel.
  Evidence: A real validation run created `message_id=38,39,40,41`, successfully performed single-photo `editMedia`, album item `editMedia`, sent an appended extra photo, performed an album shrink with no additional Telegram API calls, and then deleted all 4 created test messages during cleanup.

- Observation: Under `soft`, reducing or removing photos is intentionally a Telegram no-op for old media.
  Evidence: The real album shrink from 3 photos to 1 produced `shrinkAddedCalls=[]`; fake-Telegram regression tests now assert that old Telegram message rows are retained under `soft`, while `TELEGRAM_MEDIA_SYNC_POLICY=rebuild` deletes old media and republishes the current text/photo state.

- Observation: A scheduled post must be cancellable by a later inactive/non-social webhook before the scheduler runs.
  Evidence: Previously the filter returned `ignored` before loading the stored row, so a future `scheduled` row could still be published later. The orchestrator now marks pending rows without Telegram message refs as `ignored` and clears `scheduled_at`; `tests/scheduler.test.ts` verifies that `runDuePosts` does not publish the cancelled post.

- Observation: Telegram retry can be handled at the API-client boundary without changing fake-client orchestration tests.
  Evidence: `TelegramBotApiClient` now retries only network failures, HTTP `429`, and HTTP `5xx`; permanent `4xx` errors fail immediately and still flow into the existing `failed` row behavior. `tests/telegramClient.test.ts` verifies both transient retry and permanent no-retry behavior.

- Observation: The scheduled worker still does not own a full delayed retry queue for rows already marked `failed`.
  Evidence: The current worker marks a failed due row as `failed` after Telegram client retries are exhausted. A later matching webhook retries because `failed` rows bypass hash idempotency, and `publishing` rows do the same, but automatic backoff for `failed` scheduled rows would require a new retry-attempt/next-retry design.

- Observation: Request-log redaction is not enough on its own if lower-level errors contain secret-shaped values.
  Evidence: `processBitrixEvent` and `runDuePosts` persist `last_error`, and the Telegram client wraps API/network errors. A shared `redactSensitiveText` helper now strips explicit bot-token values and common `bot...`, `authorization`, `x-webhook-secret`, `TELEGRAM_BOT_TOKEN`, and `WEBHOOK_SECRET` patterns before errors are returned or stored.

- Observation: Unhandled error logging needs its own redaction layer in addition to request-log paths and `last_error` redaction.
  Evidence: Fastify route errors, scheduler outer errors, and startup failures can be logged outside the normal publish failure path. `redactErrorForLog` now redacts message and stack text before those errors are logged or printed, and the webhook route returns a generic `internal_error` response for unexpected failures.

- Observation: The real production sample sends `all_properties.PHOTOS` as a Bitrix file id string such as `"253902"`, not as a URL object.
  Evidence: Telegram cannot publish a Bitrix file id directly. Before active posts with photos can be safely published, either the webhook/n8n mapping must include photo URL/path objects, or the service must gain a Bitrix API/file resolver that converts file ids to public HTTPS URLs.

- Observation: Dropping URL-less `PHOTOS` during normalization silently changes an intended media post into a text-only post.
  Evidence: The parser now keeps `PHOTOS: "253902"` as an unresolved photo id, and `processBitrixEvent` writes a `failed` row with a clear resolver/mapping error before any Telegram call. Regression tests cover this production payload shape.

- Observation: Failed edit rows with existing Telegram message refs must not retry through the new-publication path.
  Evidence: Unresolved photo payloads can mark an already published row as `failed` while preserving Telegram refs. The orchestrator now retries such rows through the edit/delete path when refs exist, avoiding duplicate publication on the next corrected webhook.

- Observation: The desired production/n8n photo shape is now URL-bearing objects, not Bitrix file id strings.
  Evidence: The new sanitized production data says `body.all_properties.PHOTOS` can arrive as `[{ id, url, path }, ...]` and this is the primary source for photos. For this payload shape the service does not need a Bitrix file resolver; unresolved string ids remain a fail-safe for older or incomplete mappings.

- Observation: `active_from` can arrive with an exact time, e.g. `11.06.2026 00:05:00`, and date-only values should no longer be treated as midnight.
  Evidence: The user provided the production-shaped payload with `active_from: "11.06.2026 00:05:00"` and clarified that if exact time is absent, the post must not be sent and the admin must be notified.

- Observation: Production can send `post_type: "Новинки"`, which is a business/news category but was previously parsed as `unknown`.
  Evidence: The 2026-07-06 production log for Bitrix id `181848` showed `postTypeRaw: "Новинки"` with `postType: "unknown"`, so the service selected the format-only prompt instead of the company-news prompt.

- Observation: A scheduled multi-social post can be partially published even when the worker result is `failed`.
  Evidence: `runDuePosts` records Telegram/MAX publications before surfacing a VK failure; the aggregate log only showed `{ checked: 1, published: 0, failed: 1 }`, while the client's report said Telegram and MAX received the post but VK did not.

- Observation: A static `VK_ACCESS_TOKEN` is not a production credential for wall-photo upload.
  Evidence: VK ID access tokens expire after about one hour and production reached `access token not existed`. The service now stores the VK ID refresh-token pair in SQLite and refreshes the user token before photo upload, with one forced refresh/retry when VK reports token invalidation.

## Decision Log

- Decision: Store Bitrix post state separately from individual Telegram messages.
  Rationale: One Bitrix element can produce more than one Telegram message when it has multiple photos or when photos are added to a prior text-only post.
  Date/Author: 2026-06-04 / Codex

- Decision: Treat AI usage as text fitting, not creative rewriting.
  Rationale: The user explicitly stated that the goal is to fit Telegram limits, not to change the text unnecessarily.
  Date/Author: 2026-06-04 / Codex

- Decision: Use OpenRouter for production AI text fitting, but call it only when Telegram hard limits are exceeded.
  Rationale: The user has an OpenRouter token, and short texts should not be changed or slowed down. OpenRouter failures must not block publication, so deterministic truncation remains the final fallback.
  Date/Author: 2026-06-08 / Codex

- Decision: Default to plain text Telegram formatting until the user confirms HTML or MarkdownV2.
  Rationale: Plain text avoids entity parsing errors and makes length checks more reliable for the first working version.
  Date/Author: 2026-06-04 / Codex

- Decision: Use an internal scheduled worker in the first implementation unless deployment requires multiple replicas.
  Rationale: The simplest reliable version can poll the database for due scheduled posts. If the service runs in multiple instances, database locking must be added before production.
  Date/Author: 2026-06-04 / Codex

- Decision: Use local SQLite as the default database for the first implementation, with migrations owned by the service.
  Rationale: SQLite makes the service independent from n8n and external Postgres while still supporting the needed tables, idempotency, scheduled posts, and multiple Telegram message ids. The project is expected to run as a single service instance for MVP.
  Date/Author: 2026-06-04 / Codex

- Decision: Keep `n8n_gateway` documented only as a temporary fallback and do not implement raw SQL webhook access.
  Rationale: If n8n is ever used as a bridge, arbitrary SQL over a public webhook is unsafe. The safer shape is `action + params` mapped to allowlisted parameterized SQL inside n8n.
  Date/Author: 2026-06-04 / Codex

- Decision: Treat `ACTIVE_FROM`/`DATE_ACTIVE_FROM` as the default Bitrix activity-start candidates, while keeping `BITRIX_ACTIVE_FROM_FIELD` as an override for the exact project payload.
  Rationale: The sample webhook still does not contain the field, but these are the standard Bitrix names. Supporting both lets the service work with common Bitrix/n8n mappings without hiding the need to confirm the production payload.
  Date/Author: 2026-06-04 / Codex

- Decision: Parse Bitrix `DD.MM.YYYY HH:MM:SS` timestamps with a configurable Bitrix local UTC offset when no timezone is present.
  Rationale: The production server runs on Linux/UTC while Bitrix sends local Moscow-style strings such as `11.06.2026 00:05:00`. `BITRIX_LOCAL_UTC_OFFSET_MINUTES=180` makes scheduling independent from the VPS process timezone; explicit timezone strings still use their own offset.
  Date/Author: 2026-06-05 / Codex

- Decision: Use `soft` media sync as the default edit policy.
  Rationale: Soft sync avoids deleting visible Telegram messages: it edits single photos or album items by index, edits captions only when changed, and sends newly added album photos as extra messages. If Bitrix removes photos, old Telegram media remains visible unless production explicitly chooses `rebuild`.
  Date/Author: 2026-06-04 / Codex

- Decision: Treat photo deletion/removal under `soft` as non-destructive.
  Rationale: Telegram deletions are visible in the channel and can reorder or disturb an album. The MVP stores the latest Bitrix photo list in `bitrix_posts.photos` but leaves existing Telegram messages intact under `soft`; exact visual sync is available through opt-in `TELEGRAM_MEDIA_SYNC_POLICY=rebuild`.
  Date/Author: 2026-06-04 / Codex

- Decision: Build Telegram source text from Bitrix title/preview/detail aliases and do not append URLs by default.
  Rationale: `url` in the current contract may be an administrative Bitrix link. Public link inclusion should wait for a confirmed public field such as `DETAIL_PAGE_URL`.
  Date/Author: 2026-06-04 / Codex

- Decision: For MVP, inactive or non-social updates cancel only not-yet-published pending posts; already published Telegram messages are left untouched.
  Rationale: This preserves the original "do not touch Telegram when inactive" rule while preventing the scheduler from publishing content that Bitrix has since marked inactive. Production can still choose an explicit deletion policy for already published posts.
  Date/Author: 2026-06-04 / Codex

- Decision: Validate `WEBHOOK_SECRET` with a constant-time comparison when it is configured.
  Rationale: The shared secret should not be exposed in logs or compared with ordinary string equality on the public webhook path.
  Date/Author: 2026-06-04 / Codex

- Decision: Redact `x-webhook-secret` and `authorization` from request logs.
  Rationale: Header-based webhook auth is only useful if the secret is not echoed into application logs during normal request logging or debugging.
  Date/Author: 2026-06-04 / Codex

- Decision: Retry only transient Telegram Bot API failures in the client.
  Rationale: Network failures, rate limiting, and server errors can succeed on retry, while permanent `4xx` errors usually mean bad configuration or an invalid request and should surface quickly as `failed`.
  Date/Author: 2026-06-04 / Codex

- Decision: Redact secret-shaped values before persisting failure messages.
  Rationale: `last_error` is useful for support, but it must not become a secondary store for bot tokens, webhook secrets, or authorization headers if an upstream error message includes them.
  Date/Author: 2026-06-04 / Codex

- Decision: Treat unhandled server errors as private implementation details.
  Rationale: Unexpected exceptions may include raw upstream payloads, tokens, headers, or stack frames. The service should log a redacted error object for operators and return only `internal_error` to webhook callers.
  Date/Author: 2026-06-04 / Codex

- Decision: Use `active_from` as the production activity-start field.
  Rationale: The real payload includes lowercase `active_from`. Exact date-time values such as `11.06.2026 00:05:00` are valid. Date-only values are not safe publication times and now block publication with an admin notification.
  Date/Author: 2026-06-04 / User

- Decision: Do not publish active/social posts when the activity-start field is date-only.
  Rationale: A date-only value does not contain the exact publication time. Publishing at inferred midnight is no longer acceptable; the service should fail the row and notify the admin instead.
  Date/Author: 2026-06-05 / User

- Decision: Publish on any non-empty `pub_news_social` value and do not append links to Telegram posts.
  Rationale: The user confirmed `pub_news_social = null` means do not publish; any value means publish. The current `url` is an admin Bitrix URL, so Telegram posts should not include a link.
  Date/Author: 2026-06-04 / User

- Decision: Delete already published Telegram messages when Bitrix later sends `active=N`.
  Rationale: Production should remove inactive content from Telegram instead of leaving old published messages visible.
  Date/Author: 2026-06-04 / User

- Decision: Delete removed Bitrix photos from Telegram.
  Rationale: Production should visually match Bitrix when photos are removed. This points production toward hard media sync/rebuild behavior rather than the previous non-destructive MVP `soft` default.
  Date/Author: 2026-06-04 / User

- Decision: Retry a failed scheduled post automatically after 5 minutes, then notify an admin if the retry also fails.
  Rationale: A transient Telegram failure should get one automatic recovery attempt, but repeated failure should be visible to an operator.
  Date/Author: 2026-06-04 / User

- Decision: Keep webhook security simple for now.
  Rationale: The user expects only the trusted Bitrix/n8n path to send webhooks and wants the service to work without extra IP/signature complexity in the next production step.
  Date/Author: 2026-06-04 / User

- Decision: Fail active/social posts that contain unresolved Bitrix photo ids instead of publishing them as text-only.
  Rationale: Telegram cannot send a Bitrix file id directly, and silently dropping the photo would publish incomplete content. The safe path is a `failed` row with an operator-readable error until n8n sends `{ id, url, path }` objects or a Bitrix file resolver is implemented.
  Date/Author: 2026-06-04 / Codex

- Decision: Make `rebuild` the default Telegram media sync policy.
  Rationale: Production now requires removed Bitrix photos to disappear from Telegram. `soft` remains available through `TELEGRAM_MEDIA_SYNC_POLICY=soft`, but the default behavior must match production's hard-sync expectation.
  Date/Author: 2026-06-04 / Codex

- Decision: Use `TELEGRAM_ADMIN_CHAT_ID` as the admin notification destination.
  Rationale: Scheduled retry notifications need a destination that may differ from the public target channel. The service will not guess one; if the env var is absent, it still performs the 5-minute retry but cannot send the final admin alert.
  Date/Author: 2026-06-04 / Codex

- Decision: Treat `body.all_properties.PHOTOS` as the primary photo source when it contains an array of `{ id, url, path }` objects.
  Rationale: Production/n8n can now send public URL-bearing photo objects. This avoids a Bitrix file resolver for the desired payload while still preserving the unresolved-id fail-safe for string-only `PHOTOS` values.
  Date/Author: 2026-06-04 / User

- Decision: Keep `BITRIX_FILE_RESOLVER_URL` optional because the primary production payload already sends URL-bearing photo arrays.
  Rationale: The real payload can send `body.all_properties.PHOTOS` as `[{ id, url, path }, ...]`, which is enough for Telegram publication. If an older payload sends `PHOTOS: "253902"` without URL, the service uses `BITRIX_FILE_RESOLVER_URL` when configured; if no URL is available, it fails safely and notifies the admin instead of publishing incomplete text-only content.
  Date/Author: 2026-06-05 / User

- Decision: Fall back to multipart file upload when Telegram cannot fetch a URL-bearing Bitrix photo.
  Rationale: Production Bitrix can provide public-looking URLs that include spaces or are reachable from the service host while Telegram rejects them with URL-content/media errors. The Telegram client now preserves the fast URL path, but for URL-fetch failures it downloads the image itself and sends `sendPhoto`, `sendMediaGroup`, or `editMessageMedia` as multipart with `attach://` media references.
  Date/Author: 2026-06-05 / Codex

- Decision: Default production photo delivery to service-side upload.
  Rationale: The URL-first fallback still depends on matching Telegram's exact error wording. Upload-first removes Telegram URL fetching from the primary path: the service downloads Bitrix photos itself and uploads files to Telegram. Operators can set `TELEGRAM_PHOTO_DELIVERY_MODE=auto` to try URL first or `url` to disable upload fallback.
  Date/Author: 2026-06-05 / Codex

- Decision: Set the documented admin notification env value to `TELEGRAM_ADMIN_CHAT_ID=609150103`.
  Rationale: The admin destination is now known, but it should remain configuration, not a hardcoded application constant.
  Date/Author: 2026-06-04 / User

- Decision: Make `publish_social` the master switch and `publish_targets` the canonical per-platform selector.
  Rationale: Bitrix now has one master checkbox plus individual Telegram/VK/MAX checkboxes. The master false state must override all targets so content managers can disable every social publication from one field.
  Date/Author: 2026-06-26 / User

- Decision: Keep Telegram editable but make VK/MAX publish/delete only for the first multi-social release.
  Rationale: Telegram edit semantics are already implemented and tested with stored message refs. VK/MAX editing introduces platform-specific constraints and is not required for this release; target-level `social_publications` still prevents duplicates and supports best-effort delete.
  Date/Author: 2026-06-26 / Codex

- Decision: Use the internal scheduler for VK/MAX even though VK `wall.post` supports `publish_date`.
  Rationale: One queue keeps SQLite state, retry, admin notifications, and duplicate prevention consistent across Telegram, VK, and MAX.
  Date/Author: 2026-06-26 / Codex

- Decision: Run AI preparation for every post type, with different prompt modes.
  Rationale: `event`, `promo`, and `company_news` use their business SMM prompts. `entertainment`, `unknown`, and any other non-business type use a format-only prompt that preserves the original meaning/facts and only adds light structure plus 1-3 relevant emoji.
  Date/Author: 2026-07-01 / User

- Decision: Treat Bitrix `Новинки` as `company_news`.
  Rationale: Production uses `Новинки` for a business/news-like item. Parsing it as `unknown` sends the format-only AI prompt and makes the resulting post look like AI did not apply the intended news prompt.
  Date/Author: 2026-07-06 / Codex

- Decision: Log AI preparation fallback and per-post scheduled publication failures.
  Rationale: Operators need to distinguish "AI was expected" from "AI succeeded", and need the exact failed platform/error when a scheduled VK/MAX/TG publication is only partially successful.
  Date/Author: 2026-07-06 / Codex

- Decision: Log successful AI preparation as an explicit operational event.
  Rationale: Comparing final post wording is not a reliable way to prove whether OpenRouter ran. The service now logs successful AI preparation with `bitrixId`, `postType`, input/output lengths, target, truncation flag, and duration, while empty or failed AI responses continue into deterministic fallback with a warning.
  Date/Author: 2026-07-07 / Codex

- Decision: Replace the static VK user access-token path with VK ID OAuth refresh storage, while keeping `VK_ACCESS_TOKEN` as a legacy fallback.
  Rationale: VK wall photo methods need a user access token, and the manually created access token expires too quickly for scheduled publication. Persisting the rotated `refresh_token` lets the service refresh access before publishing without asking the operator to recreate tokens hourly. `VK_TOKEN` remains available for current community-token wall post/delete behavior.
  Date/Author: 2026-07-08 / Codex

## Outcomes & Retrospective

The first application scaffold is complete. The project now has a TypeScript/Fastify service, config loading, Bitrix webhook parser, text fitting helpers, Telegram Bot API client interface and implementation, SQLite gateway with migration, posting orchestrator, scheduled publishing worker, sample webhook, and tests. Verification on 2026-06-04 at 13:05+03:00: `npm test` passed 28 tests in 6 files, and `npm run build` passed. The dev server has already been checked on `http://127.0.0.1:18080` from an ignored local `.env`; `/health` returned `OK`. Real Telegram validation against the test channel succeeded earlier: text post `message_id=33`, photo post `message_id=35`, and media group `message_id=36,37` were published; repeat payloads returned `unchanged`; the text update edited `message_id=33` instead of creating a duplicate. The current code additionally supports Bitrix activity-start aliases, Bitrix localized date parsing, uppercase Bitrix text fields, HTML/plain-text normalization, and fake-Telegram coverage for soft media edits.

2026-06-05 verification: after adding multipart upload fallback for Telegram photo URL fetch failures, `npm test` passed 79 tests in 10 files and `npm run build` passed. After changing the default to upload-first delivery and adding failed-result logging, `npm test` passed 82 tests in 10 files and `npm run build` passed.

2026-06-05 verification: after broadening Bitrix/PHP photo parsing and adding parsed-event photo diagnostics, `npm test` passed 90 tests in 10 files and `npm run build` passed.

2026-06-05 verification: after fixing Bitrix local-time parsing and exact-time enforcement, `npm test` passed 97 tests in 10 files and `npm run build` passed. A real local Telegram E2E run also passed without printing secrets: the service stored a future `active_from` post with two local URL photos containing spaces, `runDuePosts` published it through upload-first `sendMediaGroup`, a text change edited the album caption, photo removal rebuilt the album into a text post, and `active=N` deleted the remaining Telegram message.

Additional verification on 2026-06-04 at 13:22+03:00: `npm test` passed 32 tests in 7 files. A real Telegram soft-flow run in the test channel validated single-photo media edit, album item edit, appended extra photo, and shrink/no-op behavior under `soft`; created messages `38,39,40,41` were deleted successfully during cleanup. Remaining production-specific choices are exact Bitrix activity-start field and timezone, public URL field, exact meaning/routing of `pub_news_social`, and whether production wants the default non-destructive `soft` policy or explicit `rebuild` when photos are removed.

Additional verification on 2026-06-04 at 13:35+03:00: `npm test` passed 35 tests in 7 files, and `npm run build` passed. New coverage proves that a future scheduled post is cancelled when a later `active: "N"` webhook arrives before publication, an already published post stays published and receives no Telegram API calls on `active: "N"`, and the webhook route accepts the configured shared secret while still rejecting wrong secrets.

Additional verification on 2026-06-04 at 13:51+03:00: `npm test` passed 40 tests in 8 files, and `npm run build` passed. New coverage proves that `TelegramBotApiClient` retries transient `5xx` failures but does not retry permanent `400` failures, `TELEGRAM_RETRY_ATTEMPTS`/`TELEGRAM_RETRY_DELAY_MS` load from env, request-log redaction includes the webhook secret header, and stuck `publishing` rows retry even when the payload hash is unchanged.

Additional verification on 2026-06-04 at 14:06+03:00: `npm test` passed 45 tests in 9 files, and `npm run build` passed. New coverage proves that secret-shaped values are redacted from Telegram API/network errors, failed immediate publication errors, and failed scheduled publication `last_error` values before they are returned or stored.

Additional verification on 2026-06-04 at 14:21+03:00: `npm test` passed 48 tests in 9 files, and `npm run build` passed. New coverage proves that JSON-style header/env secret values are redacted, `Error` message/stack output is made log-safe, and unexpected webhook route failures return a generic `internal_error` response without raw secret-bearing error details. Server startup and scheduler outer error logging now use the same redacted error representation.

Additional verification on 2026-06-04 at 15:05+03:00: initial baseline `npm test` passed 48 tests in 9 files and `npm run build` passed. After the production safety milestone, `npm test` passed 54 tests in 9 files and `npm run build` passed. New coverage proves that Bitrix `PHOTOS` file id strings are preserved as unresolved photos, active/social unresolved-photo posts fail without Telegram calls, `active=N` deletes already published Telegram messages, scheduled failures retry once at +5 minutes, final scheduled failures can notify an admin notifier, config defaults to `TELEGRAM_MEDIA_SYNC_POLICY=rebuild`, and SQLite migrations persist scheduled retry/admin notification state. Remaining production blocker: real photo publication still needs either webhook/n8n URL mapping or a Bitrix file resolver. `TELEGRAM_ADMIN_CHAT_ID` still needs a production value before admin alerts can be sent.

Additional verification on 2026-06-04 at 16:30+03:00: `npm test` passed 60 tests in 9 files, and `npm run build` passed. New coverage proves that production `body.all_properties.PHOTOS` arrays preserve `id`, `url`, and `path`; `active=N` with photo objects does not publish a new post; `active=N` deletes every message from an already published media group; active URL-bearing photo arrays publish through `sendMediaGroup`; Telegram client URL-encodes spaces before media-group API calls; and `.env.example` documents both `TELEGRAM_ADMIN_CHAT_ID=609150103` and `SQLITE_DB_PATH=./data/bitrix-tg.sqlite`.

Additional verification on 2026-06-05 at 09:15+03:00: `npm test` passed 62 tests in 9 files, and `npm run build` passed. New coverage proves that the parser marks date-only `active_from` as `scheduledAtPrecision: "date"`, exact `DD.MM.YYYY HH:MM:SS` values as `datetime`, and `processBitrixEvent` fails active/social date-only posts without Telegram calls while notifying the admin notifier.

Additional verification on 2026-06-05 at 09:56+03:00: `npm test` passed 75 tests in 10 files, and `npm run build` passed. New coverage proves that the service defaults to port `18080`, the HTTP Bitrix photo resolver calls `POST { "ids": [...] }`, URL-bearing photo arrays do not call the resolver, raw `PHOTOS: "253902"` can publish after resolver URL mapping, mixed URL/id photo arrays publish as media groups after partial resolution, unresolved resolver results fail without Telegram calls and notify the admin, the webhook route passes the resolver dependency, and the scheduled worker resolves old stored photo ids before publishing. A non-mutating Telegram credentials check also confirmed `getMe` and `getChat` succeed for the current ignored `.env`.

Additional verification on 2026-06-08 at 11:55+03:00: `npm test` passed 119 tests in 11 files, and `npm run build` passed. New coverage proves that short texts bypass AI, over-limit text/captions use the injected text fitter, empty AI responses, AI failures, and over-limit AI responses fall back to deterministic truncation, webhook and scheduled publication store fitted text, OpenRouter requests use the chat-completions contract, and OpenRouter/OpenAI secret-shaped values are redacted from errors.

Additional verification on 2026-06-26 at 18:40+03:00: `npm run build` passed and `npm test` passed 145 tests in 14 files. New coverage proves canonical target parsing and master override, SMM prompt selection, Telegram/VK/MAX scheduled publishing together, duplicate webhook protection across all targets, VK/MAX no-edit/no-duplicate behavior on content change, newly enabled targets publishing once, unchecked/master-disabled targets deleting stored publications, MAX image URL attachment/retry/delete flow, and VK wall photo upload plus group wall posting.

Additional verification on 2026-07-06 at 18:08+03:00: `npm test -- --run` passed 164 tests in 14 files, and `npm run build` passed. New coverage proves that `Новинки` maps to `company_news`, AI preparation failures call a diagnostic hook before deterministic fallback, and scheduled external-target failures report Bitrix id, selected targets, retry state, next retry time, and redacted aggregate error.

Additional verification on 2026-07-07 at 09:00+03:00: `npm test -- --run` passed 165 tests in 14 files, and `npm run build` passed. New coverage proves that every AI preparation request carries the Bitrix id for logging, empty AI responses are reported before deterministic fallback, and the server logs successful AI preparation without exposing secrets.

## Context and Orientation

The repository is currently empty except for documentation created for this project. The requirements wiki lives in `docs/wiki`. The most important files are:

- `docs/wiki/index.md`, the catalog of wiki pages.
- `docs/wiki/business-rules.md`, the detailed publishing and editing rules.
- `docs/wiki/data-model.md`, the proposed database model.
- `docs/wiki/telegram-publishing.md`, the Telegram Bot API behavior.
- `docs/wiki/open-questions.md`, the questions that must be answered or deliberately defaulted before coding.

The service to build is a webhook receiver. A webhook receiver is an HTTP endpoint that accepts JSON from another system. Here, Bitrix sends news element changes, possibly through the old n8n flow, and this new service decides whether to publish to Telegram.

The key Bitrix identifier is `element_id`. In this service it is stored as `bitrix_id`. A Telegram `message_id` is the identifier returned by Telegram after the bot sends a message. The pair `chat_id` plus `message_id` identifies a message that can later be edited.

Telegram has different limits for different message types. A normal text message supports up to 4096 characters after Telegram parses formatting entities. A photo caption supports up to 1024 characters after entity parsing. Because of that, the service must prepare text differently for `sendMessage` and for photo captions.

## Assumptions To Use Unless The User Overrides Them

Use Node.js with TypeScript for the first implementation. Use Fastify for HTTP routing, SQLite for the MVP durable state, direct Telegram Bot API calls through `fetch`, and OpenRouter for optional text fitting only when Telegram limits are exceeded. These choices keep the service small, explicit, independent from n8n, and easy to test.

Use `sqlite` as the default database access mode. The service owns its SQLite file and creates tables through migrations. This keeps the service independent from n8n and from the Postgres container that currently exists only inside n8n's docker-compose setup. Keep `direct_postgres` available as a later production path if the service is deployed into a shared docker-compose network, and keep `n8n_gateway` only as an emergency bridge.

Use one fixed Telegram destination from environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- optional `TELEGRAM_MESSAGE_THREAD_ID`
- `TELEGRAM_RETRY_ATTEMPTS`, defaulting to `3`
- `TELEGRAM_RETRY_DELAY_MS`, defaulting to `500`

Use these additional environment variables:

- `DATABASE_URL`
- `DB_ACCESS_MODE`, defaulting to `sqlite`
- `SQLITE_DB_PATH`, defaulting to `./data/bitrix-tg.sqlite`
- `N8N_DB_GATEWAY_URL`
- `N8N_DB_GATEWAY_SECRET`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`, defaulting to `openai/gpt-4.1-mini`
- `OPENROUTER_API_BASE_URL`, defaulting to `https://openrouter.ai/api/v1`
- `OPENROUTER_SITE_URL`
- `OPENROUTER_APP_TITLE`, defaulting to `bitrix-tg`
- `OPENROUTER_TIMEOUT_MS`, defaulting to `20000`
- `OPENAI_API_KEY` and `OPENAI_MODEL` as backward-compatible OpenRouter fallbacks
- `MAX_TOKEN`, `MAX_CHAT_ID`, `MAX_API_BASE_URL`, defaulting to `https://platform-api2.max.ru`
- optional local MAX TLS helper `NODE_EXTRA_CA_CERTS=./data/certs/russian_trusted_ca_bundle.pem`
- `VK_TOKEN` as the community token for `wall.post`/`wall.delete`
- `VK_ACCESS_TOKEN` as a legacy static user token fallback for `photos.getWallUploadServer`/`photos.saveWallPhoto`
- `VK_CLIENT_ID`, `VK_REDIRECT_URI`, optional `VK_SERVICE_TOKEN`, `VK_OAUTH_SCOPE`, `VK_OAUTH_AUTH_URL`, `VK_OAUTH_TOKEN_URL`, `VK_OAUTH_ADMIN_SECRET`, and `VK_OAUTH_TOKEN_REFRESH_SKEW_SECONDS` for the preferred VK ID OAuth refresh flow
- `VK_GROUP_ID`, `VK_API_VERSION`, defaulting to `5.199`, and `VK_POST_AS_GROUP`, defaulting to `true`
- `WEBHOOK_SECRET`, if webhook authentication is enabled
- `PORT`, defaulting to `18080`

If the real project requires Python, MySQL, SQLite, multiple Telegram channels, or a different AI provider, update this section and the implementation steps before coding.

## Plan of Work

First, scaffold a TypeScript service. Create `package.json`, `tsconfig.json`, a `src` directory, and test tooling. The HTTP server should expose `POST /webhooks/bitrix` for incoming payloads and `GET /health` for a simple health check.

Second, implement configuration loading in `src/config.ts`. It should read environment variables, validate required values at startup, and fail with a clear error if a required variable is missing.

Third, implement database access and migrations. Create a SQLite-backed database module as the first implementation. Create a `bitrix_posts` table for one row per Bitrix element and a `telegram_messages` table for every Telegram message created for that element. The schema must support text posts, one-photo posts, media groups, mixed text-plus-extra-photo posts, scheduled posts, payload hashes, and failure state. Keep the database code behind a small interface so a later `direct_postgres` adapter can replace SQLite if production requires it.

Fourth, implement webhook parsing in `src/bitrix/parseWebhook.ts`. It should accept either an array of webhook envelopes or one envelope, extract `body`, validate `element_id`, normalize `active`, normalize `pub_news_social`, normalize `PHOTOS` into an array, collect source text fields, parse `scheduledAt`, and compute a stable payload hash from the normalized state.

Fifth, implement filtering. If `active` is not `"Y"`, return an ignored result and do not touch Telegram. If `pub_news_social` is empty, return an ignored result and do not touch Telegram. Log ignored events so support can see why nothing happened.

Sixth, implement text building and fitting. Create `src/text/buildText.ts` to assemble the Telegram text from the confirmed Bitrix fields. Create `src/text/fitText.ts` to check limits and call the AI provider only when the text is too long. After AI returns, check the length again and use deterministic truncation if needed.

Seventh, implement a Telegram client in `src/telegram/client.ts`. It should support `sendMessage`, `editMessageText`, `sendPhoto`, `sendMediaGroup`, `editMessageCaption`, `editMessageMedia`, and `deleteMessage` if the chosen media policy needs deletion. It should return typed results containing `chat_id`, `message_id`, and any `file_id` values available.

Eighth, implement the posting orchestrator in `src/poster/processBitrixEvent.ts`. This function should load the existing `bitrix_posts` row by `bitrix_id`. If none exists, create one and publish or schedule it. If one exists and the payload hash is unchanged, do nothing. If the row exists and the payload changed, apply the edit path described in `docs/wiki/business-rules.md`.

Ninth, implement scheduled publishing in `src/scheduler/runDuePosts.ts`. It should find posts with `status = 'scheduled'` and `scheduled_at <= now`, publish the latest stored state, and mark success or failure. If the app may run more than one instance, add database row locking so only one worker publishes each due post.

Tenth, add tests and sample payloads. Unit tests should cover parsing, photo normalization, filters, text fitting, idempotency, and edit decision logic. Integration tests should use a fake Telegram client so they can prove message creation and updates without sending real Telegram messages.

## Concrete Steps

Start in the repository root:

    cd D:\AI\bitrix-tg

Create the TypeScript project:

    npm init -y
    npm install fastify zod dotenv sqlite sqlite3
    npm install -D typescript tsx vitest @types/node

Create project files:

    package.json
    tsconfig.json
    src/server.ts
    src/config.ts
    src/bitrix/parseWebhook.ts
    src/text/buildText.ts
    src/text/fitText.ts
    src/telegram/client.ts
    src/poster/processBitrixEvent.ts
    src/scheduler/runDuePosts.ts
    src/db/DbGateway.ts
    src/db/SqliteGateway.ts
    migrations/001_create_posts.sql
    tests/parseWebhook.test.ts
    tests/processBitrixEvent.test.ts
    tests/sqliteGateway.test.ts
    tests/server.test.ts
    samples/bitrix-webhook.json

Create `src/db/DirectPostgresGateway.ts` only if production deployment requires multiple service instances or a shared Postgres database.

After scaffolding, `npm test` should run and initially pass at least the health check and parser tests:

    npm test

Expected shape:

    ✓ tests/parseWebhook.test.ts
    ✓ tests/processBitrixEvent.test.ts

Run the development server:

    npm run dev

Expected health check:

    curl http://localhost:18080/health
    OK

Send a sample webhook:

    curl -X POST http://localhost:18080/webhooks/bitrix -H "Content-Type: application/json" --data "@samples/bitrix-webhook.json"

Expected response for an active, social-enabled element:

    {"ok":true,"processed":1,"published":1,"ignored":0}

Expected response for `active: "N"`:

    {"ok":true,"processed":1,"published":0,"ignored":1}

## Validation and Acceptance

The feature is accepted when the following behaviors are demonstrated.

First, `GET /health` returns HTTP 200 with body `OK`.

Second, sending a webhook with `active: "N"` creates no Telegram message and returns an ignored result.

Third, sending a webhook with `active: "Y"`, non-empty `pub_news_social`, and no photos creates one Telegram text message, stores the Bitrix row, stores the Telegram message row, and returns the created message id.

Fourth, sending the same webhook again does not create a duplicate message because the payload hash is unchanged.

Fifth, sending the same `element_id` with changed text edits the existing Telegram text message instead of sending a new one.

Sixth, sending a new active webhook with one photo creates one Telegram photo message with caption and stores its message id.

Seventh, sending a new active webhook with multiple photos creates a Telegram media group and stores every returned message id.

Eighth, sending an update where a previously text-only post now has photos keeps the original text message and sends the photo or album as additional Telegram message rows.

Ninth, sending a webhook with future `scheduledAt` stores the post as `scheduled` and does not publish immediately. When the worker runs after that time, the post appears in Telegram exactly once.

Tenth, tests pass:

    npm test

The tests should include fake Telegram responses so they are stable without network access.

## Idempotence and Recovery

Webhook processing must be idempotent. Repeating the same payload must not create duplicate Telegram messages. The payload hash should be computed from the normalized fields that affect publication: Bitrix id, active state, social flag, assembled source text, photo URLs or ids, and scheduled time.

Database writes should be ordered so a crash can be retried safely. For a new post, create or update the `bitrix_posts` row before publishing, mark it `publishing` during Telegram calls, then mark it `published` only after Telegram returns message ids. If Telegram fails, store `failed` and `last_error`.

Do not delete Telegram messages during retries unless the selected media policy explicitly requires it. Deletion is user-visible and should be logged.

If a migration fails, fix the migration and rerun it on a clean development database. For production, take a database backup before running destructive migrations. The first version should avoid destructive migrations.

## Artifacts and Notes

The incoming sample has this important shape:

    [
      {
        "body": {
          "action": "update",
          "element_id": 181692,
          "active": "N",
          "name": "тесеен123",
          "preview_text": "анонасс1",
          "detail_text": "пожробно",
          "pub_news_social": "2976",
          "all_properties": {
            "PHOTOS": {
              "id": "253888",
              "url": "https://svarnoy-market.ru/upload/iblock/b45/i2y1hfi4s1wjfsepx551ztp99um7o2wm/2026-01-15 19.47.41.jpg",
              "path": "/upload/iblock/b45/i2y1hfi4s1wjfsepx551ztp99um7o2wm/2026-01-15 19.47.41.jpg"
            },
            "pub_news_social": "2976"
          }
        }
      }
    ]

For this sample, the correct result is ignore, because `active` is `"N"`.

## Interfaces and Dependencies

The parser should expose a function with this shape:

    parseBitrixWebhook(input: unknown): ParsedBitrixEvent[]

Each `ParsedBitrixEvent` should contain:

    bitrixId: number
    isActive: boolean
    socialValue: string | string[]
    title: string
    previewText: string
    detailText: string
    photos: NormalizedPhoto[]
    scheduledAt: Date | null
    payloadHash: string
    rawBody: unknown

The text fitting module should expose:

    fitForTelegramText(text: string): Promise<string>
    fitForTelegramCaption(text: string): Promise<string>

The Telegram client interface should expose:

    sendText(input): Promise<TelegramMessageRef>
    editText(input): Promise<TelegramMessageRef>
    sendPhoto(input): Promise<TelegramMessageRef>
    sendMediaGroup(input): Promise<TelegramMessageRef[]>
    editCaption(input): Promise<TelegramMessageRef>
    editMedia(input): Promise<TelegramMessageRef>

`TelegramMessageRef` should contain at least:

    chatId: string
    messageId: number
    role: "text" | "photo" | "album_item" | "extra_photo"
    mediaIndex?: number
    mediaUrl?: string

The orchestrator should expose:

    processBitrixEvent(event: ParsedBitrixEvent): Promise<ProcessResult>

`ProcessResult` should state whether the event was ignored, scheduled, published, edited, unchanged, or failed.

## Plan Revision Notes

2026-06-04 / Codex: Created the initial self-contained ExecPlan from the user's n8n workflow description and the external `PLANS.md` instructions. The plan deliberately records unresolved decisions instead of hiding them, because media editing, scheduling field names, and deployment choices materially affect implementation.
