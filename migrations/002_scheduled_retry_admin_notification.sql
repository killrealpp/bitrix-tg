ALTER TABLE bitrix_posts
  ADD COLUMN scheduled_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bitrix_posts
  ADD COLUMN admin_notified_at TEXT;
