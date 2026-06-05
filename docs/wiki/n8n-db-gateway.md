---
title: "n8n DB gateway"
created: 2026-06-04
tags:
  - n8n
  - postgres
  - database
  - gateway
---

# n8n DB gateway

Если Postgres доступен только внутри docker-compose, где запущен n8n, сервис `bitrix-tg` может временно работать с базой через n8n webhook. Это не идеальная долгосрочная архитектура, но хороший старт: не нужно сразу менять docker-compose, открывать порт Postgres наружу или переносить сервис внутрь той же сети.

## Главное правило безопасности

Не отправлять сырой SQL в открытый webhook. Нельзя делать Postgres node с query вида `{{$json.body.sql}}`, если webhook доступен из интернета и без authentication. Такой вариант превращает n8n в публичную SQL-консоль.

Безопасный вариант: сервис отправляет JSON с `secret`, `action` и `params`, а n8n внутри workflow выбирает SQL из allowlist. Значения передаются через Query Parameters Postgres node. По документации n8n, Query Parameters санитизируются и защищают от SQL injection.

Источник: https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres/

## URL

Текущий webhook:

    POST https://n8n.svarnoy.org/webhook/8fae2cce-562b-47b4-95db-cc240df910bd

В `.env` сервиса:

    DB_ACCESS_MODE=n8n_gateway
    N8N_DB_GATEWAY_URL=https://n8n.svarnoy.org/webhook/8fae2cce-562b-47b4-95db-cc240df910bd
    N8N_DB_GATEWAY_SECRET=<long-random-secret>

## Формат запроса

Пример:

    {
      "secret": "long-random-secret",
      "action": "getPostByBitrixId",
      "params": {
        "bitrixId": 181692
      }
    }

Пример ответа:

    {
      "ok": true,
      "rows": [
        {
          "id": 1,
          "bitrix_id": 181692,
          "status": "published",
          "chat_id": "-100...",
          "main_message_id": 123
        }
      ]
    }

## Минимальный workflow n8n

Ноды:

1. `Webhook` - принимает POST.
2. `Code` - проверяет secret, action и params, затем возвращает фиксированный SQL и массив параметров.
3. `Postgres` - Operation: Execute Query.
4. `Respond to Webhook` - возвращает `{ ok, rows }` или ошибку.

В Postgres node:

    Query:
    {{ $json.query }}

    Query Parameters:
    {{ $json.parameters }}

Если текущая версия n8n не принимает массив параметров в этом поле, нужно использовать режим Query Parameters из Options и передавать параметры так, как ожидает установленная версия n8n. Важно сохранить принцип: SQL выбирается из allowlist, значения идут параметрами.

## Code node allowlist

Code node должен быть примерно таким по смыслу:

    const body = $json.body ?? {};
    const expectedSecret = $env.N8N_DB_GATEWAY_SECRET;

    if (!expectedSecret || body.secret !== expectedSecret) {
      throw new Error('Unauthorized DB gateway request');
    }

    const action = body.action;
    const params = body.params ?? {};

    const queries = {
      getPostByBitrixId: () => ({
        query: `
          select *
          from bitrix_posts
          where bitrix_id = $1
          limit 1
        `,
        parameters: [Number(params.bitrixId)]
      }),

      createPost: () => ({
        query: `
          insert into bitrix_posts
            (bitrix_id, status, chat_id, main_message_id, publication_kind, scheduled_at, source_text, telegram_text, photos_json, payload_hash, last_error)
          values
            ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
          on conflict (bitrix_id) do nothing
          returning *
        `,
        parameters: [
          Number(params.bitrixId),
          params.status ?? 'scheduled',
          params.chatId ?? null,
          params.mainMessageId ?? null,
          params.publicationKind ?? null,
          params.scheduledAt ?? null,
          params.sourceText ?? '',
          params.telegramText ?? '',
          JSON.stringify(params.photos ?? []),
          params.payloadHash,
          params.lastError ?? null
        ]
      }),

      updatePostAfterTelegram: () => ({
        query: `
          update bitrix_posts
          set status = $2,
              chat_id = $3,
              main_message_id = $4,
              publication_kind = $5,
              telegram_text = $6,
              payload_hash = $7,
              last_error = null,
              updated_at = now()
          where bitrix_id = $1
          returning *
        `,
        parameters: [
          Number(params.bitrixId),
          params.status,
          params.chatId,
          params.mainMessageId,
          params.publicationKind,
          params.telegramText,
          params.payloadHash
        ]
      }),

      listTelegramMessages: () => ({
        query: `
          select tm.*
          from telegram_messages tm
          join bitrix_posts bp on bp.id = tm.post_id
          where bp.bitrix_id = $1
          order by tm.media_index nulls first, tm.id
        `,
        parameters: [Number(params.bitrixId)]
      }),

      addTelegramMessage: () => ({
        query: `
          insert into telegram_messages
            (post_id, chat_id, tg_message_id, role, media_index, media_url, telegram_file_id)
          select id, $2, $3, $4, $5, $6, $7
          from bitrix_posts
          where bitrix_id = $1
          returning *
        `,
        parameters: [
          Number(params.bitrixId),
          params.chatId,
          Number(params.messageId),
          params.role,
          params.mediaIndex ?? null,
          params.mediaUrl ?? null,
          params.telegramFileId ?? null
        ]
      }),

      markFailed: () => ({
        query: `
          update bitrix_posts
          set status = 'failed',
              last_error = $2,
              updated_at = now()
          where bitrix_id = $1
          returning *
        `,
        parameters: [Number(params.bitrixId), String(params.error ?? '')]
      })
    };

    if (!queries[action]) {
      throw new Error(`Unsupported DB gateway action: ${action}`);
    }

    return [queries[action]()];

## Нужные таблицы

Перед рабочими запросами в Postgres нужно создать таблицы из [[data-model]]. Это можно сделать либо миграцией через отдельный n8n action `runMigration001`, либо вручную в базе.

Для старта можно добавить action `runMigration001`, но его лучше отключить после первого запуска.

## Когда уйти от gateway

Когда сервис будет готов к production, лучше добавить его контейнером в тот же docker-compose network, где живут n8n и Postgres. Тогда сервис сможет использовать обычный `DATABASE_URL`, а n8n перестанет быть прослойкой для базы.

