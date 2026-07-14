---
title: "Бизнес-правила"
created: 2026-06-04
tags:
  - bitrix
  - telegram
  - rules
---

# Бизнес-правила

Эта страница превращает исходное описание в исполнимые правила. Здесь слово "пост" означает элемент Битрикс, который может быть опубликован в Telegram одним сообщением или набором сообщений.

## Общий фильтр

Событие не должно менять Telegram, если `active` не равно `"Y"`. В исходном ТЗ это правило описано как "если N, то не трогаем".

Событие не должно менять Telegram, если `pub_news_social` пустой. Под пустым значением понимаются `null`, отсутствующее поле, пустая строка или пустой массив. Если внутри есть значение, сервис продолжает обработку.

После прохождения фильтра `PHOTOS` всегда приводится к массиву. Это нужно, чтобы дальнейшие сценарии не зависели от того, пришла одна фотография объектом или несколько фотографий массивом.

2026-06-04 / текущая реализация: если `active != "Y"` или `pub_news_social` пустой для еще не опубликованной pending-записи без Telegram-сообщений, сервис переводит эту запись в `ignored` и очищает `scheduled_at`, чтобы scheduler не опубликовал уже неактуальный пост.

2026-06-04 / текущая production-реализация: если уже опубликованный пост позднее приходит как `active: "N"`, сервис удаляет сохраненные Telegram-сообщения через `deleteMessage`, очищает Telegram refs в базе и переводит строку в `ignored`. Ответ обработки получает статус `deleted`.

## Поиск состояния в базе

Сервис берет `element_id` и ищет запись с таким `bitrix_id`.

Если записи нет, это новый пост. Сервис создает запись в базе с `bitrix_id`, статусом подготовки или публикации, пустыми Telegram-сообщениями и нормализованными данными.

Если запись есть, это обновление уже известного поста. Сервис сравнивает новое состояние с сохраненным и применяет нужные изменения в Telegram.

## Новый пост без фото

Если новый пост прошел фильтр и `photos` пустой, сервис собирает текст публикации, подгоняет его под лимит текстового сообщения Telegram и отправляет через `sendMessage`.

После успешной отправки сервис сохраняет `chat_id`, `tg_message_id`, тип публикации `text` и финальный текст, который был отправлен.

## Новый пост с фото

Если новый пост содержит одну фотографию, сервис собирает caption, подгоняет его под лимит caption Telegram и отправляет через `sendPhoto`.

Если новый пост содержит несколько фотографий, сервис отправляет альбом через `sendMediaGroup`. Caption можно прикрепить к первому элементу альбома. Telegram возвращает несколько сообщений, поэтому сервис должен сохранить `message_id` каждого сообщения, а не только один `tg_message_id`.

После успешной отправки сервис сохраняет `chat_id`, список Telegram-сообщений, тип публикации `photo` или `media_group`, список фото и финальный caption.

## Обновление текстового поста

Если в базе пост был опубликован как текстовый и новый нормализованный пост тоже без фото, сервис подгоняет новый текст под лимит и редактирует существующее сообщение через `editMessageText`.

ИИ в этом сценарии не должен переписывать стиль ради красоты. Его задача - только сохранить смысл и сделать текст достаточно коротким для Telegram.

## К текстовому посту добавили фото

Исходное пожелание: если раньше в Telegram был только текст, а в Битрикс добавили фото, текст в Telegram не меняется, а фото просто добавляется.

Практическое следствие: Telegram Bot API не позволяет превратить уже отправленное текстовое сообщение в медиа-сообщение с фото. Поэтому реализация должна отправить фото отдельным сообщением или альбомом после старого текста и сохранить дополнительные `message_id`.

Это один из главных аргументов в пользу отдельной таблицы Telegram-сообщений, описанной в [[data-model]].

## К фото добавили или изменили текст

Если раньше был пост с фото без caption, а в Битрикс добавили текст, сервис подгоняет caption и редактирует медиа-сообщение через `editMessageCaption`, если структура медиа позволяет это сделать.

Если это альбом, caption обычно хранится на первом сообщении альбома. В этом случае редактируется caption первого сообщения.

## Фото изменили, добавили или удалили

Если изменилось одно фото в одиночном медиа-сообщении, можно использовать `editMessageMedia`.

Если изменился альбом, самый надежный вариант - удалить старые медиа-сообщения и отправить новый альбом, но это может изменить порядок сообщений и создать заметный эффект в Telegram-канале. Более мягкий вариант - редактировать существующие сообщения по индексам и досылать новые, если фото добавились. Политику нужно подтвердить в [[open-questions]].

2026-06-04 / текущая реализация: default-политика `soft`. Она редактирует одиночное фото через `editMessageMedia`, редактирует элементы альбома по индексу, если URL фото изменился, и досылает добавленные фото отдельными сообщениями. Старые фото при удалении из Битрикс не удаляются из Telegram без явного `rebuild`-решения. Для постов типа `mixed` исходное текстовое сообщение редактируется через `editMessageText`, а дополнительные фото синхронизируются отдельно.

2026-06-04 / решение по удалению фото: для MVP выбран безопасный default `soft`. Если в Битрикс фото удалили или уменьшили список `PHOTOS`, сервис сохраняет новое нормализованное состояние Битрикс в `bitrix_posts.photos`, но не удаляет старые Telegram-сообщения и не перестраивает альбом. Так канал не получает заметных удалений. Если production требует точного визуального соответствия Битрикс, нужно явно включить `TELEGRAM_MEDIA_SYNC_POLICY=rebuild`: тогда старые media-сообщения удаляются через `deleteMessage`, а актуальное состояние публикуется заново.

2026-06-04 / production decision: если фото удалили в Битрикс, их нужно удалить из Telegram. Значит следующий production milestone должен перевести media sync на hard delete/rebuild behavior или добавить отдельную политику удаления только removed-фото.

2026-06-04 / текущая production-реализация: default-политика теперь `rebuild`. Если список фото меняется, старые media-сообщения удаляются через `deleteMessage`, а актуальное состояние публикуется заново. `soft` остается доступной явной настройкой `TELEGRAM_MEDIA_SYNC_POLICY=soft` для non-destructive режима.

## Неразрешенные Bitrix file id в `PHOTOS`

Production payload может прислать `all_properties.PHOTOS` как строку Bitrix file id, например `"253902"`. Это не Telegram file id и не публичный HTTPS URL.

2026-06-04 / текущая реализация: parser сохраняет такое значение как unresolved photo id. Если пост активный и `pub_news_social` непустой, сервис не публикует его как text-only. Вместо этого он сохраняет/возвращает `failed` с понятной ошибкой о том, что нужен URL в mapping или Bitrix file resolver. Для неактивных или non-social событий обычные ignore/delete-правила выполняются раньше.

## Повтор одинакового вебхука

Сервис должен считать хэш нормализованного состояния. Если повторно пришел тот же `bitrix_id` с тем же текстом, фото, активностью, соц-признаком и временем публикации, Telegram не должен получать дубль или лишнее редактирование.

2026-06-04 / текущая реализация: совпадение `payload_hash` считается `unchanged` только для строк в статусах `published` и `scheduled`. Строки `failed` и `publishing` с тем же payload не блокируются хэшем: сервис повторяет publish path, чтобы можно было восстановиться после временной ошибки Telegram или падения процесса во время публикации.

## Ошибки Telegram

Клиент Telegram повторяет временные ошибки: сетевые сбои, `429` и `5xx`. Постоянные ошибки вроде неверного chat id, token или прав бота не повторяются. Если после retry операция все равно не удалась, пост получает статус `failed`, а последняя ошибка сохраняется в `last_error`.

2026-06-04 / текущая реализация: перед возвратом ошибки и сохранением `last_error` сервис редактирует чувствительные фрагменты: Telegram bot-token, `authorization`, `x-webhook-secret`, `TELEGRAM_BOT_TOKEN` и `WEBHOOK_SECRET`. Это дополняет redaction request-логов и защищает базу от утечек через текст исключений.

2026-06-04 / текущая реализация: неожиданные ошибки вне обычного publish-failure path тоже проходят redaction перед логированием. Это касается unhandled ошибок webhook route, внешнего catch scheduler worker и startup console error. Клиент webhook получает generic `internal_error`, а не raw stack/message.

## Связанные страницы

- [[input-webhook-contract]]
- [[data-model]]
- [[telegram-publishing]]
- [[ai-text-fitting]]
- [[scheduled-publishing]]

## 2026-06-05 / Release Rule: Photo Id Resolution

Before scheduling, publishing, or editing an active social post, unresolved
Bitrix photo ids are resolved through the configured Bitrix file resolver. The
resolver is called only for photos that do not already have a URL.

If every photo has a URL after resolution, the normal Telegram flow continues:
one photo uses `sendPhoto`, multiple photos use `sendMediaGroup`, and stored
photo state uses the resolved `{ id, url, path }` values.

If any photo remains unresolved, the service must not publish a text-only
fallback. It stores `failed`, keeps the unresolved photo ids in state for audit,
and sends an admin notification when `TELEGRAM_ADMIN_CHAT_ID` is configured.

## 2026-06-05 / Release Rule: Exact Time Required By Default

For the release service, active social posts require an exact activity-start
time by default. This is controlled by:

```env
BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true
BITRIX_LOCAL_UTC_OFFSET_MINUTES=180
```

`active_from: "11.06.2026 00:05:00"` is valid and is scheduled. Missing
`active_from`, date-only values such as `"11.06.2026"`, or invalid date strings
produce `failed`, skip Telegram publication, and notify the admin when the admin
chat is configured.

## 2026-06-26 / Multi-Social Publishing Rules

2026-07-14 update: VK publishing is disabled. The active targets are Telegram
and MAX. Incoming `publish_targets.vk`, legacy `publish_vk`, and
`pub_news_vkpost` values are normalized to `false` and do not create, delete, or
retry VK publications.

The Bitrix master checkbox is now authoritative. Canonical webhook field:
`publish_social`. If it is false/empty, the service does not create new posts,
cancels scheduled rows, and deletes already published targets where stored refs
and API permissions allow it.

Per-target canonical fields live in `publish_targets`:

```json
{
  "publish_targets": {
    "telegram": true,
    "vk": false,
    "max": true
  }
}
```

If a single target checkbox is turned off later, only that target is deleted.
Other still-selected targets remain published.

Telegram keeps the existing edit/rebuild behavior. VK and MAX are deliberately
publish/delete only in this release: if content changes after VK/MAX publication,
the service updates its Bitrix state but does not edit and does not duplicate the
VK/MAX post. If a target is enabled later and has no saved successful
publication, it is published exactly once.

Post type controls text preparation:

- `event`, `promo`, `company_news` call OpenRouter with the matching SMM prompt
  and target a post up to 1000 characters;
- `entertainment`, `unknown`, and any other non-business type call OpenRouter
  with a format-only prompt: preserve meaning and facts, add light structure and
  1-3 relevant emoji, and do not turn the text into a sale/event/company-news
  post;
- all platform limits are enforced after preparation.
