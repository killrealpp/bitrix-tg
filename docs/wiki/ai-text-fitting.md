---
title: "Подгонка текста через ИИ"
created: 2026-06-04
tags:
  - ai
  - text
  - telegram
---

# Подготовка и подгонка текста через ИИ

2026-06-26 / multi-social release: ИИ используется в двух режимах. Для типов
`event`, `promo` и `company_news` он адаптирует исходные данные под SMM-промпт
магазина "СВАРНОЙ" и возвращает готовый пост до 1000 символов. Для
`entertainment` и `unknown` ИИ не вызывается: сервис делает только
детерминированное форматирование.

После подготовки все платформенные лимиты все равно проверяются. Если OpenRouter
недоступен, вернул пусто или слишком длинно, публикация не блокируется:
сервис применяет deterministic truncation.

## Когда вызывается ИИ

Для `event`, `promo`, `company_news` сервис вызывает `aiPrepare` всегда после
сборки текста из Bitrix-полей и до platform-fit. Для остальных типов этот шаг
пропускается.

Затем сервис проверяет платформенные лимиты:

- обычное Telegram-сообщение: hard limit `4096`, target `3900`;
- caption у фото или альбома: hard limit `1024`, target `950`.
- MAX text: hard limit `4000`, target `3800`;
- VK: используется консервативный внутренний fit, но SMM-подготовка уже целится
  в 1000 символов.

Если итоговый текст не помещается в hard limit, сервис применяет deterministic
truncation по границе предложения/слова и продолжает публикацию.

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
- для `event`, `promo`, `company_news` соблюдать соответствующий SMM-промпт и
  ограничение около 1000 символов.

## Надежность

OpenRouter token и legacy `OPENAI_API_KEY` считаются секретами и проходят redaction в ошибках и логах. Сбой ИИ не должен блокировать публикацию: в худшем случае пост публикуется с deterministic truncation.

## Связанные страницы

- [[business-rules]]
- [[telegram-publishing]]
