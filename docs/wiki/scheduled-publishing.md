---
title: "Публикация по началу активности"
created: 2026-06-04
tags:
  - scheduling
  - bitrix
  - telegram
---

# Публикация по полю "начало активности"

В ТЗ есть требование: пост должен публиковаться в Telegram в момент из поля "начало активности". В примере JSON это поле отсутствует, поэтому для реализации нужно уточнить точное имя поля и формат даты.

## Правило обработки времени

После прохождения фильтров `active == "Y"` и непустого `pub_news_social` сервис должен определить `scheduledAt`.

Если `scheduledAt` отсутствует или находится в прошлом, пост публикуется сразу.

Если `scheduledAt` находится в будущем, сервис сохраняет пост в статусе `scheduled` и не отправляет его в Telegram до указанного времени.

2026-06-05 / production safety: если поле `active_from` или другой найденный activity-start field содержит только дату без точного времени, например `11.06.2026`, сервис не должен выводить из этого `00:00`. Для активного social-поста такая запись получает `failed`, Telegram-публикация не вызывается, и admin notifier отправляет сообщение о необходимости указать точное время. Значение с временем, например `11.06.2026 00:05:00`, считается точным.

Если до наступления времени приходит новый вебхук с тем же `element_id`, сервис обновляет отложенную запись: текст, фото, хэш и время публикации должны соответствовать последней версии Битрикс.

Если до наступления времени приходит `active != "Y"` или пустой `pub_news_social`, текущая MVP-реализация отменяет отложенную запись: статус становится `ignored`, `scheduled_at` очищается, и worker больше не берет этот пост к публикации.

## Worker публикации

Нужен фоновый процесс, который регулярно ищет записи `scheduled`, у которых `scheduled_at <= now`, и публикует их.

Если сервис будет запущен в одном экземпляре, достаточно периодического worker внутри приложения. Если сервис будет запущен в нескольких экземплярах, нужна блокировка записи в базе, чтобы два процесса не опубликовали один пост дважды.

2026-06-04 / текущая реализация: worker перед публикацией переводит due-строку в `publishing`. Telegram-клиент сам делает retry временных ошибок (`429`, `5xx`, network). Если публикация все равно падает впервые для этой scheduled-строки, worker возвращает ее в `scheduled`, ставит `scheduled_at = now + 5 minutes`, увеличивает `scheduled_retry_count` и сохраняет redacted `last_error`. Если повтор через 5 минут тоже падает, worker переводит строку в `failed`.

Внешний catch scheduler worker, который срабатывает только при неожиданном сбое самого worker, тоже логирует ошибку через redacted message/stack. Обычные ошибки публикации по конкретной due-строке остаются внутри `failed` + redacted `last_error`.

2026-06-04 / текущая production-реализация: после повторной ошибки worker пытается отправить admin notification через `TELEGRAM_ADMIN_CHAT_ID`, если этот env задан. Если admin destination не задан, строка все равно остается `failed`, но уведомление отправить некуда.

2026-06-04 / production admin destination: `TELEGRAM_ADMIN_CHAT_ID=609150103` is the configured admin notification target. The value belongs in env/config, not in application code.

## Поведение при `active == "N"`

В исходном ТЗ сказано, что при `active == "N"` сервис ничего не трогает. Для MVP это уточнено так:

- если пост только запланирован и еще не имеет Telegram-сообщений, отложенная публикация отменяется;
- если пост уже опубликован в Telegram, сервис возвращает `ignored` и оставляет Telegram-сообщения без изменений.

2026-06-04 / текущая production-реализация: если Битрикс позднее присылает `active == "N"` для уже опубликованного поста, Telegram-сообщения удаляются, Telegram refs очищаются из базы, а строка переводится в `ignored`.

## Связанные страницы

- [[business-rules]]
- [[input-webhook-contract]]
- [[open-questions]]

## 2026-06-05 / Scheduled Posts With Photo Ids

The webhook path resolves Bitrix photo ids before storing a future scheduled
post whenever `BITRIX_FILE_RESOLVER_URL` is configured. This means scheduled
rows normally contain URL-bearing photo objects by the time the worker publishes
them.

For compatibility with rows stored before the resolver was introduced, the
scheduled worker also attempts the same resolver step before Telegram calls. If
resolution fails or returns no URL, the due row follows the existing scheduled
failure policy: one delayed retry, then `failed` plus admin notification when the
admin chat is configured.

## 2026-06-05 / Production Timezone And Exact Time

Production Bitrix timestamps without an explicit timezone are treated as Bitrix
local time, not as the VPS process timezone. The release default is:

```env
BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true
BITRIX_LOCAL_UTC_OFFSET_MINUTES=180
```

With these defaults, `11.06.2026 00:05:00` is parsed as Moscow time and stored
in SQLite as UTC `2026-06-10T21:05:00.000Z`. The worker publishes when current
UTC time reaches that stored value.

If an active social payload has no activity-start field, has only a date, or has
an invalid date value, the service stores `failed`, does not call Telegram, and
notifies the admin when `TELEGRAM_ADMIN_CHAT_ID` is configured.

The server logs non-empty scheduler runs as `Scheduled publishing worker result`
with `{ checked, published, failed }`, so `journalctl -u bitrix-tg -f` shows
whether the queue actually picked up due posts.

## 2026-06-08 / Multiple Due Posts

The scheduler reads due rows with `findDueScheduledPosts(now, limit)` and
publishes each row in that result set. The default worker limit remains 25 per
run, so one scheduled post waiting in the queue does not block other due posts
from being published in the same pass.

Regression coverage verifies two different Bitrix elements scheduled for the
same timestamp: the worker returns `{ checked: 2, published: 2, failed: 0 }`
and sends both the text post and the media group.

## 2026-06-26 / Multi-Social Scheduling

The same internal scheduler is used for Telegram and MAX. VK support was
disabled on 2026-07-14, so due posts ignore stored or incoming VK target flags.

When a future Bitrix post is due, the worker publishes every selected target
that has not already been successfully published. Telegram stores exact message
refs in `telegram_messages`; MAX stores one row in `social_publications`.

If a target client is missing from env at due time, the worker treats that row as
a scheduled publication failure and applies the normal retry/final-failure path.
