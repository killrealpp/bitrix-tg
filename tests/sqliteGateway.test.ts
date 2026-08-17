import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteGateway,
  type SqliteGateway
} from "../src/db/SqliteGateway";

describe("SqliteGateway", () => {
  let db: SqliteGateway | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it("runs migrations and stores posts with multiple Telegram messages", async () => {
    db = await openSqliteGateway({
      filename: ":memory:",
      migrationsDir: path.resolve(process.cwd(), "migrations")
    });

    const post = await db.createPost({
      bitrixId: 10,
      status: "published",
      chatId: "-100-test",
      mainMessageId: 501,
      publicationKind: "media_group",
      sourceText: "Album",
      telegramText: "Album",
      preparedText: "Telegram Album",
      preparedTexts: {
        telegram: "Telegram Album",
        max: "MAX Album"
      },
      photos: [
        { url: "https://example.com/a.jpg" },
        { url: "https://example.com/b.jpg" }
      ],
      payloadHash: "hash",
      scheduledRetryCount: 1,
      adminNotifiedAt: new Date("2026-06-04T13:05:00.000Z")
    });

    await db.replaceTelegramMessages(post.id, [
      {
        chatId: "-100-test",
        tgMessageId: 501,
        role: "album_item",
        mediaIndex: 0,
        mediaUrl: "https://example.com/a.jpg"
      },
      {
        chatId: "-100-test",
        tgMessageId: 502,
        role: "album_item",
        mediaIndex: 1,
        mediaUrl: "https://example.com/b.jpg"
      }
    ]);

    const loaded = await db.findPostByBitrixId(10);
    const messages = await db.listTelegramMessages(post.id);

    expect(loaded?.publicationKind).toBe("media_group");
    expect(loaded?.preparedText).toBe("Telegram Album");
    expect(loaded?.preparedTexts).toEqual({
      telegram: "Telegram Album",
      max: "MAX Album"
    });
    expect(loaded?.photos).toHaveLength(2);
    expect(loaded?.scheduledRetryCount).toBe(1);
    expect(loaded?.adminNotifiedAt?.toISOString()).toBe(
      "2026-06-04T13:05:00.000Z"
    );
    expect(messages.map((message) => message.tgMessageId)).toEqual([501, 502]);
  });

  it("reuses the existing row when two webhooks race to create the same post", async () => {
    db = await openSqliteGateway({
      filename: ":memory:",
      migrationsDir: path.resolve(process.cwd(), "migrations")
    });

    const input = {
      bitrixId: 181892,
      status: "scheduled" as const,
      sourceText: "Термофены",
      photos: [],
      payloadHash: "hash-a"
    };

    const first = await db.createPost(input);
    const second = await db.createPost({ ...input, payloadHash: "hash-b" });

    expect(second.id).toBe(first.id);
    expect(second.payloadHash).toBe("hash-a");

    const all = await db.findPostByBitrixId(181892);
    expect(all?.id).toBe(first.id);
  });
});
