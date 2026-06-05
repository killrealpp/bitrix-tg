CREATE TABLE IF NOT EXISTS bitrix_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bitrix_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('ignored', 'scheduled', 'publishing', 'published', 'failed')
  ),
  chat_id TEXT,
  main_message_id INTEGER,
  publication_kind TEXT CHECK (
    publication_kind IS NULL
    OR publication_kind IN ('text', 'photo', 'media_group', 'mixed')
  ),
  scheduled_at TEXT,
  source_text TEXT NOT NULL DEFAULT '',
  telegram_text TEXT,
  photos_json TEXT NOT NULL DEFAULT '[]',
  payload_hash TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bitrix_posts_status_scheduled
  ON bitrix_posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES bitrix_posts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  tg_message_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('text', 'photo', 'album_item', 'extra_photo')
  ),
  media_index INTEGER,
  media_url TEXT,
  telegram_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chat_id, tg_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_post_id
  ON telegram_messages (post_id);
