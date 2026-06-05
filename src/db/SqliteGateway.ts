import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import type {
  DbGateway,
  PersistPostInput,
  PersistTelegramMessageInput,
  StoredBitrixPost,
  StoredTelegramMessage,
  UpdatePostPatch
} from "./DbGateway";
import type { NormalizedPhoto } from "../bitrix/parseWebhook";
import type { TelegramMessageRole } from "../telegram/client";

export interface OpenSqliteGatewayOptions {
  filename: string;
  migrationsDir?: string;
}

interface BitrixPostRow {
  id: number;
  bitrix_id: number;
  status: StoredBitrixPost["status"];
  chat_id: string | null;
  main_message_id: number | null;
  publication_kind: StoredBitrixPost["publicationKind"];
  scheduled_at: string | null;
  source_text: string;
  telegram_text: string | null;
  photos_json: string;
  payload_hash: string;
  last_error: string | null;
  scheduled_retry_count: number;
  admin_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TelegramMessageRow {
  id: number;
  post_id: number;
  chat_id: string;
  tg_message_id: number;
  role: TelegramMessageRole;
  media_index: number | null;
  media_url: string | null;
  telegram_file_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function openSqliteGateway(
  options: OpenSqliteGatewayOptions
): Promise<SqliteGateway> {
  if (options.filename !== ":memory:") {
    await mkdir(path.dirname(path.resolve(options.filename)), { recursive: true });
  }

  const db = await open({
    filename: options.filename,
    driver: sqlite3.Database
  });

  const gateway = new SqliteGateway(db);
  await gateway.runMigrations(
    options.migrationsDir ?? path.resolve(process.cwd(), "migrations")
  );
  return gateway;
}

export class SqliteGateway implements DbGateway {
  constructor(private readonly db: Database) {}

  async runMigrations(migrationsDir: string): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const applied = await this.db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM schema_migrations WHERE name = ?",
        file
      );
      if (applied && applied.count > 0) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await this.db.exec("BEGIN");
      try {
        await this.db.exec(sql);
        await this.db.run("INSERT INTO schema_migrations (name) VALUES (?)", file);
        await this.db.exec("COMMIT");
      } catch (error) {
        await this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  async findPostByBitrixId(bitrixId: number): Promise<StoredBitrixPost | null> {
    const row = await this.db.get<BitrixPostRow>(
      "SELECT * FROM bitrix_posts WHERE bitrix_id = ?",
      bitrixId
    );

    return row ? mapPostRow(row) : null;
  }

  async createPost(input: PersistPostInput): Promise<StoredBitrixPost> {
    const result = await this.db.run(
      `
        INSERT INTO bitrix_posts (
          bitrix_id,
          status,
          chat_id,
          main_message_id,
          publication_kind,
          scheduled_at,
          source_text,
          telegram_text,
          photos_json,
          payload_hash,
          last_error,
          scheduled_retry_count,
          admin_notified_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.bitrixId,
      input.status,
      input.chatId ?? null,
      input.mainMessageId ?? null,
      input.publicationKind ?? null,
      serializeDate(input.scheduledAt ?? null),
      input.sourceText,
      input.telegramText ?? null,
      JSON.stringify(input.photos),
      input.payloadHash,
      input.lastError ?? null,
      input.scheduledRetryCount ?? 0,
      serializeDate(input.adminNotifiedAt ?? null)
    );

    return this.getPostById(result.lastID);
  }

  async updatePost(id: number, patch: UpdatePostPatch): Promise<StoredBitrixPost> {
    const fields: string[] = [];
    const values: unknown[] = [];

    addPatch(fields, values, "status", patch.status);
    addPatch(fields, values, "chat_id", patch.chatId);
    addPatch(fields, values, "main_message_id", patch.mainMessageId);
    addPatch(fields, values, "publication_kind", patch.publicationKind);
    if ("scheduledAt" in patch) {
      addPatch(fields, values, "scheduled_at", serializeDate(patch.scheduledAt ?? null));
    }
    addPatch(fields, values, "source_text", patch.sourceText);
    addPatch(fields, values, "telegram_text", patch.telegramText);
    if ("photos" in patch && patch.photos) {
      addPatch(fields, values, "photos_json", JSON.stringify(patch.photos));
    }
    addPatch(fields, values, "payload_hash", patch.payloadHash);
    addPatch(fields, values, "last_error", patch.lastError);
    addPatch(fields, values, "scheduled_retry_count", patch.scheduledRetryCount);
    if ("adminNotifiedAt" in patch) {
      addPatch(
        fields,
        values,
        "admin_notified_at",
        serializeDate(patch.adminNotifiedAt ?? null)
      );
    }

    if (fields.length === 0) {
      return this.getPostById(id);
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    await this.db.run(
      `UPDATE bitrix_posts SET ${fields.join(", ")} WHERE id = ?`,
      ...values,
      id
    );

    return this.getPostById(id);
  }

  async replaceTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void> {
    await this.db.exec("BEGIN");
    try {
      await this.db.run("DELETE FROM telegram_messages WHERE post_id = ?", postId);
      await this.insertTelegramMessages(postId, messages);
      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async appendTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void> {
    await this.insertTelegramMessages(postId, messages);
  }

  async listTelegramMessages(postId: number): Promise<StoredTelegramMessage[]> {
    const rows = await this.db.all<TelegramMessageRow[]>(
      "SELECT * FROM telegram_messages WHERE post_id = ? ORDER BY media_index, id",
      postId
    );

    return rows.map(mapTelegramMessageRow);
  }

  async findDueScheduledPosts(now: Date, limit: number): Promise<StoredBitrixPost[]> {
    const rows = await this.db.all<BitrixPostRow[]>(
      `
        SELECT *
        FROM bitrix_posts
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ?
      `,
      now.toISOString(),
      limit
    );

    return rows.map(mapPostRow);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async getPostById(id: number | undefined): Promise<StoredBitrixPost> {
    if (!id) {
      throw new Error("SQLite did not return last inserted id");
    }

    const row = await this.db.get<BitrixPostRow>(
      "SELECT * FROM bitrix_posts WHERE id = ?",
      id
    );
    if (!row) {
      throw new Error(`Post ${id} was not found`);
    }

    return mapPostRow(row);
  }

  private async insertTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void> {
    for (const message of messages) {
      await this.db.run(
        `
          INSERT INTO telegram_messages (
            post_id,
            chat_id,
            tg_message_id,
            role,
            media_index,
            media_url,
            telegram_file_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        postId,
        message.chatId,
        message.tgMessageId,
        message.role,
        message.mediaIndex ?? null,
        message.mediaUrl ?? null,
        message.telegramFileId ?? null
      );
    }
  }
}

function addPatch(
  fields: string[],
  values: unknown[],
  column: string,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }

  fields.push(`${column} = ?`);
  values.push(value);
}

function mapPostRow(row: BitrixPostRow): StoredBitrixPost {
  return {
    id: row.id,
    bitrixId: row.bitrix_id,
    status: row.status,
    chatId: row.chat_id,
    mainMessageId: row.main_message_id,
    publicationKind: row.publication_kind,
    scheduledAt: deserializeDate(row.scheduled_at),
    sourceText: row.source_text,
    telegramText: row.telegram_text,
    photos: parsePhotos(row.photos_json),
    payloadHash: row.payload_hash,
    lastError: row.last_error,
    scheduledRetryCount: row.scheduled_retry_count,
    adminNotifiedAt: deserializeDate(row.admin_notified_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapTelegramMessageRow(row: TelegramMessageRow): StoredTelegramMessage {
  return {
    id: row.id,
    postId: row.post_id,
    chatId: row.chat_id,
    tgMessageId: row.tg_message_id,
    role: row.role,
    mediaIndex: row.media_index,
    mediaUrl: row.media_url,
    telegramFileId: row.telegram_file_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function parsePhotos(value: string): NormalizedPhoto[] {
  const parsed = JSON.parse(value) as NormalizedPhoto[];
  return Array.isArray(parsed) ? parsed : [];
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function deserializeDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
