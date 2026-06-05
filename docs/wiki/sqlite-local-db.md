---
title: "Локальная SQLite база"
created: 2026-06-04
tags:
  - sqlite
  - database
  - migrations
---

# Локальная SQLite база

Чтобы сервис был независим от n8n и Postgres, основной вариант хранения для MVP - SQLite. SQLite - это база данных в одном файле. Сервис сам создает таблицы миграцией, читает и пишет состояние постов, а файл базы можно бэкапить и монтировать как Docker volume.

## Почему это подходит

Для проекта "Постер Битрикс" ожидается один сервис, который принимает вебхуки, публикует в Telegram и хранит соответствие `element_id` Битрикс к `message_id` Telegram. Нагрузка небольшая, а операции простые. SQLite хорошо подходит для такого single-instance сервиса.

Главное ограничение: если потом понадобится несколько одновременно запущенных экземпляров сервиса, лучше перейти на Postgres. До этого SQLite проще, дешевле и не зависит от n8n.

## Env

В `.env`:

    DB_ACCESS_MODE=sqlite
    SQLITE_DB_PATH=./data/bitrix-tg.sqlite

В Docker лучше хранить файл в volume:

    /app/data/bitrix-tg.sqlite

## Таблицы

Таблица `bitrix_posts` хранит один элемент Битрикс:

    create table if not exists bitrix_posts (
      id integer primary key autoincrement,
      bitrix_id integer not null unique,
      status text not null,
      chat_id text,
      main_message_id integer,
      publication_kind text,
      scheduled_at text,
      source_text text not null default '',
      telegram_text text not null default '',
      photos_json text not null default '[]',
      payload_hash text not null,
      last_error text,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now'))
    );

Таблица `telegram_messages` хранит каждое Telegram-сообщение, созданное для поста:

    create table if not exists telegram_messages (
      id integer primary key autoincrement,
      post_id integer not null references bitrix_posts(id) on delete cascade,
      chat_id text not null,
      tg_message_id integer not null,
      role text not null,
      media_index integer,
      media_url text,
      telegram_file_id text,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now')),
      unique (chat_id, tg_message_id)
    );

Полезные индексы:

    create index if not exists idx_bitrix_posts_status_scheduled
      on bitrix_posts(status, scheduled_at);

    create index if not exists idx_telegram_messages_post_id
      on telegram_messages(post_id);

## Миграции

Таблицы не нужно создавать вручную в n8n. В сервисе должен быть migration runner: при старте или командой `npm run db:migrate` он создает таблицу `schema_migrations`, проверяет примененные миграции и выполняет новые SQL-файлы из `migrations/`.

Минимальный подход для первой версии:

1. создать `migrations/001_create_posts.sql`;
2. при запуске открыть SQLite-файл;
3. включить `PRAGMA foreign_keys = ON`;
4. включить `PRAGMA journal_mode = WAL`;
5. применить миграции в транзакции.

`WAL` - режим журнала SQLite, который лучше подходит для сервиса: чтение и запись меньше мешают друг другу.

## Бэкап

Файл базы нужно регулярно копировать. В Docker volume это может быть отдельная cron-команда или ручной backup:

    sqlite3 data/bitrix-tg.sqlite ".backup 'backup/bitrix-tg-YYYY-MM-DD.sqlite'"

Если `sqlite3` CLI не установлен, можно добавить backup-команду в приложение позже.

## Когда перейти на Postgres

Переход на Postgres нужен, если:

- сервис запускается в нескольких экземплярах;
- webhook-нагрузка сильно выросла;
- нужна централизованная база для нескольких сервисов;
- нужны сложные отчеты, администрирование или репликация.

До этого SQLite - самый простой автономный вариант.

