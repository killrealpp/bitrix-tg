---
title: "Контракт входящего вебхука"
created: 2026-06-04
tags:
  - bitrix
  - webhook
  - contract
---

# Контракт входящего вебхука

Вебхук приходит как JSON-массив. Каждый элемент массива - это envelope n8n-стиля с `headers`, `params`, `query`, `body`, `webhookUrl` и `executionMode`. Деловые данные лежат в `body`.

## Ключевые поля `body`

- `action` - действие со стороны Битрикс. В примере пришло `update`.
- `element_id` - числовой идентификатор элемента Битрикс. В базе он хранится как `bitrix_id`.
- `active` - строка `"Y"` или `"N"`. Если значение не `"Y"`, событие игнорируется.
- `pub_news_social` - признак публикации в соцсети. Если значение `null`, пустая строка или отсутствует, событие игнорируется.
- `name` - заголовок элемента.
- `preview_text` - анонс.
- `detail_text` - подробный текст.
- `url` - административная ссылка на элемент Битрикс.
- `all_properties.PHOTOS` - фото. Может быть `null`, объектом одной фотографии или массивом фотографий.
- `all_properties.pub_news_social` - дублирующий или альтернативный признак публикации в соцсети. Нужно подтвердить, какое поле считать главным.
- поле "начало активности" - в примере отсутствует. Текущая реализация ищет `ACTIVE_FROM`, `DATE_ACTIVE_FROM`, lower-case aliases, nested `fields.*` / `all_properties.*`, либо точный путь из `BITRIX_ACTIVE_FROM_FIELD`. Production payload все еще нужно подтвердить.

2026-06-05 / production sample: реальный payload содержит lowercase `active_from`, например `11.06.2026 00:05:00`. Это считается production-полем начала активности. Если приходит только дата без времени, это больше не считается точным временем публикации: активный social-пост блокируется, переводится в `failed`, Telegram-публикация не вызывается, а администратор получает уведомление через `TELEGRAM_ADMIN_CHAT_ID`, если notifier настроен.

2026-06-04 / production decision: `pub_news_social = null` или пустое значение означает не публиковать; любое непустое значение означает публиковать. Ссылку из `url` в Telegram не добавляем, потому что это административная ссылка Bitrix.

2026-06-04 / production photo mapping: preferred payload shape is `body.all_properties.PHOTOS` as an array of objects with `{ id, url, path }`. This is the primary photo source. For this shape the service does not need a Bitrix file resolver. Envelope-level `photo_urls`, `photo_url`, and `has_photo` can be treated as auxiliary hints only.

2026-06-04 / blocker по фото: production sample содержит `all_properties.PHOTOS: "253902"`, то есть Bitrix file id без URL. Telegram Bot API не может отправить такой id напрямую. Перед публикацией фото нужно либо изменить webhook/n8n mapping, чтобы приходили `{ id, url, path }` или массив таких объектов, либо добавить в сервис Bitrix file resolver.

2026-06-04 / текущая реализация safety: parser больше не отбрасывает строковые file id. `PHOTOS: "253902"` нормализуется как unresolved photo `{ id: "253902", unresolved: true }`. Активный social-пост с таким фото получает `failed` до любых Telegram-вызовов, чтобы сервис не опубликовал неполный text-only пост.

## Безопасность webhook

2026-06-04 / текущая реализация: если задан `WEBHOOK_SECRET`, входящий `POST /webhooks/bitrix` должен передать тот же секрет в HTTP header `x-webhook-secret`. Сравнение выполняется через constant-time `crypto.timingSafeEqual`, а серверный logger настроен на redaction для `x-webhook-secret` и `authorization`, чтобы эти значения не попадали в request logs.

Секрет не должен передаваться в query string и не должен попадать в sample payload. Для production все еще можно отдельно решить, нужны ли дополнительные ограничения по IP-адресам или подписи запроса.

Дополнительно текущая реализация редактирует secret-shaped значения в текстах ошибок перед сохранением `last_error`, чтобы `WEBHOOK_SECRET` или `authorization` не утекли в базу через исключения.

Unhandled ошибки webhook route логируются только в redacted-виде: message и stack очищаются от Telegram bot-token, `authorization`, `x-webhook-secret`, `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET` и явно известных секретов из config. Ответ webhook caller в таком случае содержит только `{"ok":false,"error":"internal_error"}`.

## Нормализация входа

Сервис должен обрабатывать каждый элемент массива независимо. Если придет не массив, а одиночный объект, безопасный вариант - привести его к массиву из одного элемента, но этот допуск нужно явно подтвердить.

Для каждого элемента сервис извлекает `body`. Если `body` отсутствует, событие считается невалидным и логируется без публикации.

`PHOTOS` всегда приводится к массиву:

- `null`, пустая строка или отсутствующее поле становятся пустым массивом;
- строка или число считаются unresolved Bitrix file id без URL;
- объект с полями `id`, `url`, `path` становится массивом из одного объекта;
- объект с `id`, но без `url`, считается unresolved Bitrix file id;
- массив объектов остается массивом;
- production-массив `{ id, url, path }` сохраняет все три поля и используется без Bitrix file resolver;
- элементы без валидного `url` и без `id` отбрасываются.

## Минимальный нормализованный объект

После нормализации дальнейшие шаги должны работать не с сырым JSON, а с объектом такого смысла:

- `bitrixId` - число из `element_id`;
- `isActive` - `true`, только если `active` равно `"Y"`;
- `socialValue` - непустое значение из `pub_news_social`;
- `title` - строка из `name`;
- `previewText` - строка из `preview_text`;
- `detailText` - строка из `detail_text`;
- `photos` - массив фото;
- `photos[].unresolved` - признак, что фото пока является Bitrix file id без URL и не может быть отправлено в Telegram;
- `scheduledAt` - дата публикации из поля "начало активности" или `null`;
- `scheduledAtPrecision` - `"datetime"` для точного времени или `"date"` для даты без времени;
- `scheduledAtRawValue` - исходное значение поля времени для аудита и admin-уведомлений;
- `sourcePayload` - исходный `body` для аудита и вычисления хэша изменений.

## Связанные страницы

- [[business-rules]]
- [[data-model]]
- [[scheduled-publishing]]

## 2026-06-05 / Release Photo Resolver Contract

The primary production photo payload remains `body.all_properties.PHOTOS` as an
array of `{ id, url, path }` objects. This shape is used directly and does not
call the Bitrix file resolver.

If Bitrix sends `PHOTOS` as a string or number file id, for example `"253902"`,
the service resolves it through `BITRIX_FILE_RESOLVER_URL` before any Telegram
publication. The resolver endpoint receives:

```json
{ "ids": ["253902"] }
```

and must return:

```json
{
  "photos": [
    {
      "id": "253902",
      "url": "https://example.com/upload/photo.jpg",
      "path": "/upload/photo.jpg"
    }
  ]
}
```

`BITRIX_FILE_RESOLVER_URL` is optional when production always sends the URL
array. If a raw file id arrives and no resolver is configured, or the resolver
fails/returns no URL, the active social post is marked `failed`, Telegram is not
called, and the admin notifier is called through `TELEGRAM_ADMIN_CHAT_ID` when
configured.

## 2026-06-05 / Release Activity Time Contract

The preferred production time field is `body.active_from` with an exact value
like:

```json
{ "active_from": "11.06.2026 00:05:00" }
```

The service also keeps the existing aliases (`ACTIVE_FROM`, `DATE_ACTIVE_FROM`,
`fields.*`, `all_properties.*`, and `BITRIX_ACTIVE_FROM_FIELD`) for compatibility.

When the incoming value has no explicit timezone, it is interpreted using
`BITRIX_LOCAL_UTC_OFFSET_MINUTES`, default `180` for Moscow time. Date-only,
missing, or invalid active time values fail active social posts before Telegram
publication when `BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true`.

## 2026-06-26 / Canonical Multi-Social Fields

The direct Bitrix `init.php` integration should send these canonical fields in
the JSON body:

```json
{
  "publish_social": true,
  "publish_targets": {
    "telegram": true,
    "vk": false,
    "max": true
  },
  "post_type": "company_news",
  "section_id": 123,
  "section_name": "Events",
  "section_code": "events",
  "property_meta": [
    {
      "id": "123",
      "code": "PUBLISH_VK",
      "name": "Опубликовать в ВК (пост)",
      "value": true
    }
  ]
}
```

`publish_social` is the master switch. If it is false, individual target flags
are ignored.

2026-07-14 update: VK publishing is disabled. The parser keeps the `vk` key for
backward-compatible payload shape, but it normalizes incoming VK flags to
`false`. The active publication targets are Telegram and MAX.

`post_type` is normalized to one of:

- `event`
- `promo`
- `company_news`
- `product_new`
- `entertainment`
- `unknown`

If Bitrix does not have a dedicated social post type property, `init.php`
should send the element section fields and use `section_name` as the fallback
`post_type`. For example, a section named `События` is normalized to `event`.
`iblock_name` is the infoblock name and should not be used as the section/type
signal.

The parser still accepts legacy/fallback aliases in `all_properties`, including
`pub_news_social`, `publish_telegram`, `pub_news_tg`, `publish_vk`,
`pub_news_vkpost`, `publish_max`, `social_post_type`, and `section_name`.
VK aliases are accepted only so old Bitrix payloads stay parseable; they no
longer enable VK publication.
`property_meta` is diagnostic: it helps confirm the real Bitrix property
codes/names without exposing secrets.

The recommended `init.php` reference implementation is stored in
`docs/bitrix/init.php`.
