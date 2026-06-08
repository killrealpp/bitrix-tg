---
title: "Подгонка текста через ИИ"
created: 2026-06-04
tags:
  - ai
  - text
  - telegram
---

# Подгонка текста через ИИ

ИИ в первом релизе используется только как техническая страховка от лимитов Telegram. Он не делает творческий рерайт и не трогает короткие тексты.

## Когда вызывается ИИ

Сервис сначала собирает текст из Bitrix-полей и проверяет длину:

- обычное Telegram-сообщение: hard limit `4096`, target `3900`;
- caption у фото или альбома: hard limit `1024`, target `950`.

Если текст уже помещается в hard limit, он отправляется как есть и ИИ не вызывается.

Если текст не помещается, сервис вызывает OpenRouter и просит сократить текст до target-лимита. После ответа длина проверяется повторно. Если OpenRouter недоступен, вернул ошибку или все равно вернул слишком длинный текст, сервис применяет deterministic truncation по границе предложения/слова и продолжает публикацию.

## OpenRouter

Production text fitting использует OpenRouter Chat Completions:

- endpoint: `https://openrouter.ai/api/v1/chat/completions`;
- auth: `Authorization: Bearer <OPENROUTER_API_KEY>`;
- model из `OPENROUTER_MODEL`, например `openai/gpt-4.1-mini`;
- optional attribution headers: `HTTP-Referer` и `X-OpenRouter-Title`.

Env:

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4.1-mini
OPENROUTER_API_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=https://svarnoy-market.ru
OPENROUTER_APP_TITLE=bitrix-tg
OPENROUTER_TIMEOUT_MS=20000
```

Для обратной совместимости `OPENAI_API_KEY` и `OPENAI_MODEL` остаются fallback-алиасами. Если `OPENROUTER_API_KEY` пустой, сервис использует `OPENAI_API_KEY`; модель вида `gpt-4.1-mini` автоматически превращается в OpenRouter-compatible `openai/gpt-4.1-mini`.

## Правила поведения ИИ

ИИ должен:

- сохранять факты, даты, названия, цены, адреса, ссылки и product names;
- не добавлять новых фактов, хэштегов, приветствий или объяснений;
- сохранять исходный язык и нейтральный тон;
- возвращать только финальный текст без объяснений;
- укорачивать текст только если он не проходит лимит.

## Надежность

OpenRouter token и legacy `OPENAI_API_KEY` считаются секретами и проходят redaction в ошибках и логах. Сбой ИИ не должен блокировать публикацию: в худшем случае пост публикуется с deterministic truncation.

## Связанные страницы

- [[business-rules]]
- [[telegram-publishing]]
