ALTER TABLE bitrix_posts
  ADD COLUMN post_type TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE bitrix_posts
  ADD COLUMN publish_targets_json TEXT NOT NULL DEFAULT '{"telegram":true,"vk":false,"max":false}';

ALTER TABLE bitrix_posts
  ADD COLUMN prepared_text TEXT;

CREATE TABLE IF NOT EXISTS social_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES bitrix_posts(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('telegram', 'vk', 'max')),
  status TEXT NOT NULL CHECK (status IN ('published', 'deleted', 'failed')),
  external_id TEXT,
  external_chat_id TEXT,
  publication_kind TEXT CHECK (
    publication_kind IS NULL
    OR publication_kind IN ('text', 'photo', 'media_group', 'mixed')
  ),
  sent_text TEXT,
  photos_json TEXT NOT NULL DEFAULT '[]',
  payload_hash TEXT,
  last_error TEXT,
  published_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (post_id, target)
);

CREATE INDEX IF NOT EXISTS idx_social_publications_post_target
  ON social_publications (post_id, target);
