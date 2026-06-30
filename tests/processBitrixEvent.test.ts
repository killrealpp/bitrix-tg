import { describe, expect, it } from "vitest";
import { parseBitrixWebhook } from "../src/bitrix/parseWebhook";
import {
  processBitrixEvent,
  type MissingScheduleTimeAdminNotifier
} from "../src/poster/processBitrixEvent";
import {
  FakeBitrixPhotoResolver,
  FakeDbGateway,
  FakeExternalPublisher,
  FakeTelegramClient
} from "./fakes";

describe("processBitrixEvent", () => {
  it("ignores inactive events without touching Telegram or DB", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 1,
        active: "N",
        pub_news_social: "2976"
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("ignored");
    expect(result.reason).toBe("inactive");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts).toHaveLength(0);
  });

  it("does not publish a new inactive post even when PHOTOS contains URL objects", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 20,
        active: "N",
        pub_news_social: "2976",
        name: "Inactive album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("ignored");
    expect(result.reason).toBe("inactive");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts).toHaveLength(0);
  });

  it("deletes an already published Telegram post when Bitrix marks it inactive", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [activeEvent] = parseBitrixWebhook({
      body: {
        element_id: 16,
        active: "Y",
        pub_news_social: "2976",
        name: "Published"
      }
    });
    const [inactiveEvent] = parseBitrixWebhook({
      body: {
        element_id: 16,
        active: "N",
        pub_news_social: "2976",
        name: "Published"
      }
    });

    await processBitrixEvent(activeEvent, { db, telegram });
    const result = await processBitrixEvent(inactiveEvent, { db, telegram });

    expect(result).toMatchObject({
      status: "deleted",
      reason: "inactive"
    });
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "deleteMessage"
    ]);
    expect(db.posts[0].status).toBe("ignored");
    expect(db.messages).toHaveLength(0);
  });

  it("deletes all messages for an already published media group when Bitrix marks it inactive", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [activeEvent] = parseBitrixWebhook({
      body: {
        element_id: 21,
        active: "Y",
        pub_news_social: "2976",
        name: "Published album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });
    const [inactiveEvent] = parseBitrixWebhook({
      body: {
        element_id: 21,
        active: "N",
        pub_news_social: "2976",
        name: "Published album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    await processBitrixEvent(activeEvent, { db, telegram });
    const result = await processBitrixEvent(inactiveEvent, { db, telegram });

    expect(result).toMatchObject({
      status: "deleted",
      reason: "inactive",
      messageIds: [100, 101]
    });
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "deleteMessage",
      "deleteMessage"
    ]);
    expect(db.posts[0].status).toBe("ignored");
    expect(db.messages).toHaveLength(0);
  });

  it("publishes a new text post and stores one Telegram message", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 2,
        active: "Y",
        pub_news_social: "2976",
        name: "Title",
        preview_text: "Preview"
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(db.posts[0].publicationKind).toBe("text");
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].role).toBe("text");
  });

  it("fails active social posts with date-only active_from and notifies admin", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const adminNotifier = new FakeMissingScheduleTimeAdminNotifier();
    const now = new Date("2026-06-05T06:12:00.000Z");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 23,
        active: "Y",
        pub_news_social: "2976",
        name: "Date only",
        active_from: "11.06.2026"
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      adminNotifier,
      now
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Missing exact publication time in active_from");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0]).toMatchObject({
      status: "failed",
      lastError: result.error,
      adminNotifiedAt: now
    });
    expect(adminNotifier.calls).toEqual([
      {
        bitrixId: 23,
        sourceField: "active_from",
        rawValue: "11.06.2026",
        error: result.error
      }
    ]);
  });

  it("fails active social posts without active_from when exact time is required", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const adminNotifier = new FakeMissingScheduleTimeAdminNotifier();
    const now = new Date("2026-06-05T06:12:00.000Z");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 24,
        active: "Y",
        pub_news_social: "2976",
        name: "No time"
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      adminNotifier,
      now,
      requireExactScheduleTime: true
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "Missing exact publication time. Set active_from with HH:MM:SS before publishing."
    );
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0]).toMatchObject({
      status: "failed",
      lastError: result.error,
      adminNotifiedAt: now
    });
    expect(adminNotifier.calls).toEqual([
      {
        bitrixId: 24,
        sourceField: null,
        rawValue: null,
        error: result.error
      }
    ]);
  });

  it("does nothing for an identical repeated webhook", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 3,
        active: "Y",
        pub_news_social: "2976",
        name: "Title"
      }
    });

    await processBitrixEvent(event, { db, telegram });
    const second = await processBitrixEvent(event, { db, telegram });

    expect(second.status).toBe("unchanged");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
  });

  it("does nothing for an identical repeated album webhook", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 29,
        active: "Y",
        pub_news_social: "2976",
        name: "Same album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    await processBitrixEvent(event, { db, telegram });
    const second = await processBitrixEvent(event, { db, telegram });

    expect(second.status).toBe("unchanged");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.messages).toHaveLength(2);
  });

  it("edits an existing text post when text changes", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 4,
        active: "Y",
        pub_news_social: "2976",
        name: "First"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 4,
        active: "Y",
        pub_news_social: "2976",
        name: "Second"
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText", "editText"]);
    expect(db.posts[0].telegramText).toBe("Second");
  });

  it("publishes a new one-photo post through sendPhoto", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 5,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo post",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/photo.jpg"
          }
        }
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(db.posts[0].publicationKind).toBe("photo");
    expect(db.messages[0].role).toBe("photo");
  });

  it("publishes a new multi-photo post through sendMediaGroup", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 6,
        active: "Y",
        pub_news_social: "2976",
        name: "Album post",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" }
          ]
        }
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.role)).toEqual([
      "album_item",
      "album_item"
    ]);
  });

  it("publishes an active production PHOTOS array through sendMediaGroup", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 22,
        active: "Y",
        pub_news_social: "2976",
        name: "Production album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(telegram.calls[0].input).toMatchObject({
      photos: productionPhotos()
    });
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/2026-01-15 19.47.41.jpg",
      "https://example.com/upload/album photo 2.jpg"
    ]);
  });

  it("does not call the photo resolver for URL-bearing production PHOTOS arrays", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const photoResolver = new FakeBitrixPhotoResolver();
    photoResolver.throwError = new Error("resolver should not be called");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 24,
        active: "Y",
        pub_news_social: "2976",
        name: "Production album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      photoResolver
    });

    expect(result.status).toBe("published");
    expect(photoResolver.calls).toHaveLength(0);
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
  });

  it("resolves Bitrix photo ids before publishing a one-photo post", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const photoResolver = new FakeBitrixPhotoResolver({
      "253902": {
        id: "253902",
        url: "https://example.com/upload/resolved photo.jpg",
        path: "/upload/resolved photo.jpg"
      }
    });
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 25,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo id only",
        all_properties: {
          PHOTOS: "253902"
        }
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      photoResolver
    });

    expect(result.status).toBe("published");
    expect(photoResolver.calls).toHaveLength(1);
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(db.posts[0].photos).toEqual([
      {
        id: "253902",
        url: "https://example.com/upload/resolved photo.jpg",
        path: "/upload/resolved photo.jpg"
      }
    ]);
    expect(db.messages[0].mediaUrl).toBe(
      "https://example.com/upload/resolved photo.jpg"
    );
  });

  it("resolves mixed URL and Bitrix id photos before publishing a media group", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const photoResolver = new FakeBitrixPhotoResolver({
      "253902": {
        id: "253902",
        url: "https://example.com/upload/resolved b.jpg",
        path: "/upload/resolved b.jpg"
      }
    });
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 26,
        active: "Y",
        pub_news_social: "2976",
        name: "Mixed album",
        all_properties: {
          PHOTOS: [
            {
              id: "253901",
              url: "https://example.com/upload/a.jpg",
              path: "/upload/a.jpg"
            },
            "253902"
          ]
        }
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      photoResolver
    });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/a.jpg",
      "https://example.com/upload/resolved b.jpg"
    ]);
  });

  it("fails and notifies admin when the photo resolver returns no URL", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const adminNotifier = new FakeMissingScheduleTimeAdminNotifier();
    const photoResolver = new FakeBitrixPhotoResolver();
    const now = new Date("2026-06-05T07:00:00.000Z");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 27,
        active: "Y",
        pub_news_social: "2976",
        name: "Unresolved photo",
        all_properties: {
          PHOTOS: "253902"
        }
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      photoResolver,
      adminNotifier,
      now
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unresolved Bitrix photo id without URL: 253902");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0].status).toBe("failed");
    expect(db.posts[0].adminNotifiedAt).toBe(now);
    expect(adminNotifier.photoResolutionCalls).toEqual([
      {
        bitrixId: 27,
        photoIds: ["253902"],
        error: result.error
      }
    ]);
  });

  it("adds photos as extra messages when an existing text post receives photos", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 7,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 7,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/added.jpg"
          }
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText", "sendPhoto"]);
    expect(db.posts[0].publicationKind).toBe("mixed");
    expect(db.messages.map((message) => message.role)).toEqual(["text", "extra_photo"]);
  });

  it("adds multiple photos as an extra media group when an existing text post receives an album", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 30,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 30,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "sendMediaGroup"
    ]);
    expect(db.posts[0].publicationKind).toBe("mixed");
    expect(db.messages.map((message) => message.role)).toEqual([
      "text",
      "extra_photo",
      "extra_photo"
    ]);
  });

  it("rebuild policy replaces a text post with a media group when photos are added", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 36,
        active: "Y",
        pub_news_social: "2976",
        name: "Text becomes album"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 36,
        active: "Y",
        pub_news_social: "2976",
        name: "Text becomes album",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "deleteMessage",
      "sendMediaGroup"
    ]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.posts[0].mainMessageId).toBe(101);
    expect(db.messages.map((message) => message.role)).toEqual([
      "album_item",
      "album_item"
    ]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/2026-01-15 19.47.41.jpg",
      "https://example.com/upload/album photo 2.jpg"
    ]);
  });

  it("edits a photo caption when only media post text changes", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 10,
        active: "Y",
        pub_news_social: "2976",
        name: "Original caption",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/photo.jpg"
          }
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 10,
        active: "Y",
        pub_news_social: "2976",
        name: "Updated caption",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/photo.jpg"
          }
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "editCaption"
    ]);
    expect(db.posts[0].telegramText).toBe("Updated caption");
  });

  it("edits an album caption when only album text changes", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 31,
        active: "Y",
        pub_news_social: "2976",
        name: "Original album caption",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 31,
        active: "Y",
        pub_news_social: "2976",
        name: "Updated album caption",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "editCaption"
    ]);
    expect(db.posts[0].telegramText).toBe("Updated album caption");
    expect(db.messages).toHaveLength(2);
  });

  it("soft-edits a changed single photo through editMedia", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 11,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/old.jpg"
          }
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 11,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/new.jpg"
          }
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "editMedia"
    ]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/new.jpg"
    ]);
  });

  it("rebuild policy replaces a single-photo post with a media group when photos are added", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 32,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo grows",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/a.jpg"
          }
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 32,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo grows",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" }
          ]
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "deleteMessage",
      "sendMediaGroup"
    ]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg"
    ]);
  });

  it("soft-edits album items by index and sends newly added photos separately", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 12,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 12,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/c.jpg" },
            { url: "https://example.com/d.jpg" }
          ]
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "editMedia",
      "sendPhoto"
    ]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/c.jpg",
      "https://example.com/d.jpg"
    ]);
    expect(db.messages.map((message) => message.role)).toEqual([
      "album_item",
      "album_item",
      "extra_photo"
    ]);
  });

  it("keeps old Telegram album messages when Bitrix removes photos under soft policy", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 14,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" },
            { url: "https://example.com/c.jpg" }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 14,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [{ url: "https://example.com/a.jpg" }]
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.posts[0].photos).toEqual([{ url: "https://example.com/a.jpg" }]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
      "https://example.com/c.jpg"
    ]);
  });

  it("rebuild policy replaces an album with a single-photo post when photos shrink to one", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 33,
        active: "Y",
        pub_news_social: "2976",
        name: "Album shrinks",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 33,
        active: "Y",
        pub_news_social: "2976",
        name: "Album shrinks",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/a.jpg"
          }
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "deleteMessage",
      "deleteMessage",
      "sendPhoto"
    ]);
    expect(db.posts[0].publicationKind).toBe("photo");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/a.jpg"
    ]);
  });

  it("rebuild policy replaces a single-photo post with text when the photo is removed", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 34,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo becomes text",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/a.jpg"
          }
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 34,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo becomes text"
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "deleteMessage",
      "sendText"
    ]);
    expect(db.posts[0].publicationKind).toBe("text");
    expect(db.posts[0].photos).toEqual([]);
    expect(db.messages.map((message) => message.role)).toEqual(["text"]);
  });

  it("rebuild policy deletes old media and republishes text when Bitrix removes all photos", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 15,
        active: "Y",
        pub_news_social: "2976",
        name: "Album becomes text",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 15,
        active: "Y",
        pub_news_social: "2976",
        name: "Album becomes text"
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "rebuild"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "deleteMessage",
      "deleteMessage",
      "sendText"
    ]);
    expect(db.posts[0].publicationKind).toBe("text");
    expect(db.posts[0].photos).toEqual([]);
    expect(db.messages.map((message) => message.role)).toEqual(["text"]);
  });

  it("rebuild policy replaces a changed multi-photo album through sendMediaGroup", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 28,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/old-a.jpg" },
            { url: "https://example.com/old-b.jpg" }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 28,
        active: "Y",
        pub_news_social: "2976",
        name: "Album",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/new-a.jpg" },
            { url: "https://example.com/new-b.jpg" }
          ]
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    const result = await processBitrixEvent(second, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "deleteMessage",
      "deleteMessage",
      "sendMediaGroup"
    ]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/new-a.jpg",
      "https://example.com/new-b.jpg"
    ]);
    expect(db.messages.map((message) => message.role)).toEqual([
      "album_item",
      "album_item"
    ]);
  });

  it("rebuild policy replaces an old mixed post with the current media group when photos change", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 37,
        active: "Y",
        pub_news_social: "2976",
        name: "Old soft mixed"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 37,
        active: "Y",
        pub_news_social: "2976",
        name: "Old soft mixed",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/old-extra.jpg"
          }
        }
      }
    });
    const [third] = parseBitrixWebhook({
      body: {
        element_id: 37,
        active: "Y",
        pub_news_social: "2976",
        name: "Old soft mixed updated",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/new-a.jpg" },
            { url: "https://example.com/new-b.jpg" }
          ]
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });
    const result = await processBitrixEvent(third, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "sendPhoto",
      "deleteMessage",
      "deleteMessage",
      "sendMediaGroup"
    ]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.posts[0].telegramText).toBe("Old soft mixed updated");
    expect(db.messages.map((message) => message.role)).toEqual([
      "album_item",
      "album_item"
    ]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/new-a.jpg",
      "https://example.com/new-b.jpg"
    ]);
  });

  it("rebuild policy replaces an old mixed post with text when photos are removed", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 38,
        active: "Y",
        pub_news_social: "2976",
        name: "Mixed cleanup"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 38,
        active: "Y",
        pub_news_social: "2976",
        name: "Mixed cleanup",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/old-extra.jpg"
          }
        }
      }
    });
    const [third] = parseBitrixWebhook({
      body: {
        element_id: 38,
        active: "Y",
        pub_news_social: "2976",
        name: "Mixed cleanup no photos"
      }
    });

    await processBitrixEvent(first, { db, telegram });
    await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });
    const result = await processBitrixEvent(third, { db, telegram });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "sendPhoto",
      "deleteMessage",
      "deleteMessage",
      "sendText"
    ]);
    expect(db.posts[0].publicationKind).toBe("text");
    expect(db.posts[0].telegramText).toBe("Mixed cleanup no photos");
    expect(db.messages.map((message) => message.role)).toEqual(["text"]);
  });

  it("fails active social posts with unresolved Bitrix photo ids instead of publishing text-only", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 19,
        active: "Y",
        pub_news_social: "2976",
        name: "Photo id only",
        all_properties: {
          PHOTOS: "253902"
        }
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unresolved Bitrix photo id without URL: 253902");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0].status).toBe("failed");
    expect(db.posts[0].photos).toEqual([
      {
        id: "253902",
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      }
    ]);
    expect(db.posts[0].lastError).toBe(result.error);
  });

  it("publishes a previously failed unresolved-photo post when a later payload includes the URL", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 35,
        active: "Y",
        pub_news_social: "2976",
        name: "Later fixed photo",
        all_properties: {
          PHOTOS: "253902"
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 35,
        active: "Y",
        pub_news_social: "2976",
        name: "Later fixed photo",
        all_properties: {
          PHOTOS: {
            id: "253902",
            url: "https://example.com/fixed.jpg",
            path: "/upload/fixed.jpg"
          }
        }
      }
    });

    const failed = await processBitrixEvent(first, { db, telegram });
    const fixed = await processBitrixEvent(second, { db, telegram });

    expect(failed.status).toBe("failed");
    expect(fixed.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(db.posts[0].status).toBe("published");
    expect(db.posts[0].publicationKind).toBe("photo");
    expect(db.posts[0].lastError).toBeNull();
  });

  it("edits the original text message for mixed text-plus-photo posts", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 13,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 13,
        active: "Y",
        pub_news_social: "2976",
        name: "Text first",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/added.jpg"
          }
        }
      }
    });
    const [third] = parseBitrixWebhook({
      body: {
        element_id: 13,
        active: "Y",
        pub_news_social: "2976",
        name: "Text changed",
        all_properties: {
          PHOTOS: {
            url: "https://example.com/added.jpg"
          }
        }
      }
    });

    await processBitrixEvent(first, { db, telegram });
    await processBitrixEvent(second, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });
    const result = await processBitrixEvent(third, {
      db,
      telegram,
      mediaSyncPolicy: "soft"
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "sendPhoto",
      "editText"
    ]);
    expect(db.posts[0].telegramText).toBe("Text changed");
  });

  it("marks a new post as failed if Telegram rejects the first publication", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    telegram.sendText = async () => {
      throw new Error("Telegram chat not found");
    };
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 8,
        active: "Y",
        pub_news_social: "2976",
        name: "Will fail"
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Telegram chat not found");
    expect(db.posts[0].status).toBe("failed");
    expect(db.posts[0].lastError).toBe("Telegram chat not found");
  });

  it("redacts secret-shaped values before storing failed publication errors", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    telegram.sendText = async () => {
      throw new Error(
        "Telegram failed at https://api.telegram.org/bot123456:fake_token/sendMessage Authorization: Bearer auth-secret WEBHOOK_SECRET=webhook-secret"
      );
    };
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 18,
        active: "Y",
        pub_news_social: "2976",
        name: "Will fail safely"
      }
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain("123456:fake_token");
    expect(result.error).not.toContain("auth-secret");
    expect(result.error).not.toContain("webhook-secret");
    expect(db.posts[0].lastError).toBe(result.error);
  });

  it("retries a failed post even when the payload hash is unchanged", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    let shouldFail = true;
    const originalSendText = telegram.sendText.bind(telegram);
    telegram.sendText = async (input) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Temporary Telegram error");
      }

      return originalSendText(input);
    };
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 9,
        active: "Y",
        pub_news_social: "2976",
        name: "Retry me"
      }
    });

    const first = await processBitrixEvent(event, { db, telegram });
    const second = await processBitrixEvent(event, { db, telegram });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("published");
    expect(db.posts[0].status).toBe("published");
    expect(db.messages).toHaveLength(1);
  });

  it("retries a stuck publishing post even when the payload hash is unchanged", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 17,
        active: "Y",
        pub_news_social: "2976",
        name: "Stuck publishing"
      }
    });
    await db.createPost({
      bitrixId: event.bitrixId,
      status: "publishing",
      sourceText: "Stuck publishing",
      photos: [],
      payloadHash: event.payloadHash,
      lastError: "process exited during publish"
    });

    const result = await processBitrixEvent(event, { db, telegram });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(db.posts[0].status).toBe("published");
    expect(db.posts[0].lastError).toBeNull();
    expect(db.messages).toHaveLength(1);
  });

  it("publishes selected Telegram, VK, and MAX targets with prepared AI text", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const aiCalls: unknown[] = [];
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 40,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        post_type: "Новость компании",
        name: "Открыли новый пункт выдачи",
        all_properties: {
          PHOTOS: productionPhotos()
        }
      }
    });

    const result = await processBitrixEvent(event, {
      db,
      telegram,
      externalPublishers: { vk, max },
      textFit: {
        aiPrepare: async (request) => {
          aiCalls.push(request);
          return "AI prepared social post";
        }
      }
    });

    expect(result.status).toBe("published");
    expect(aiCalls).toHaveLength(1);
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(max.publishCalls).toHaveLength(1);
    expect(vk.publishCalls[0]).toMatchObject({
      text: "AI prepared social post",
      photos: productionPhotos()
    });
    expect(max.publishCalls[0]).toMatchObject({
      text: "AI prepared social post",
      photos: productionPhotos()
    });
    expect(db.posts[0]).toMatchObject({
      preparedText: "AI prepared social post",
      postType: "company_news",
      publishTargets: {
        telegram: true,
        vk: true,
        max: true
      }
    });
    expect(db.socialPublications.map((publication) => publication.target).sort()).toEqual([
      "max",
      "telegram",
      "vk"
    ]);
  });

  it("does not duplicate Telegram, VK, or MAX on identical repeated webhooks", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 41,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "Same everywhere"
      }
    });

    await processBitrixEvent(event, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });
    const second = await processBitrixEvent(event, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });

    expect(second.status).toBe("unchanged");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(max.publishCalls).toHaveLength(1);
  });

  it("edits Telegram text but does not republish VK or MAX when content changes", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 42,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "First social text"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 42,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "Second social text"
      }
    });

    await processBitrixEvent(first, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });
    const result = await processBitrixEvent(second, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });

    expect(result.status).toBe("edited");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText", "editText"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(max.publishCalls).toHaveLength(1);
    expect(db.socialPublications.find((item) => item.target === "vk")?.sentText).toBe(
      "First social text"
    );
  });

  it("publishes a newly enabled VK target once without touching existing Telegram", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const [telegramOnly] = parseBitrixWebhook({
      body: {
        element_id: 43,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "N",
          max: "N"
        },
        name: "Enable later"
      }
    });
    const [withVk] = parseBitrixWebhook({
      body: {
        element_id: 43,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "N"
        },
        name: "Enable later"
      }
    });

    await processBitrixEvent(telegramOnly, {
      db,
      telegram,
      externalPublishers: { vk }
    });
    const result = await processBitrixEvent(withVk, {
      db,
      telegram,
      externalPublishers: { vk }
    });

    expect(result.status).toBe("published");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(db.socialPublications.find((item) => item.target === "vk")).toMatchObject({
      status: "published"
    });
  });

  it("deletes unchecked social targets while keeping still-selected targets", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const [allTargets] = parseBitrixWebhook({
      body: {
        element_id: 44,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "Target removal"
      }
    });
    const [withoutVk] = parseBitrixWebhook({
      body: {
        element_id: 44,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "N",
          max: "Y"
        },
        name: "Target removal"
      }
    });

    await processBitrixEvent(allTargets, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });
    const result = await processBitrixEvent(withoutVk, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });

    expect(result.status).toBe("deleted");
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(vk.deleteCalls).toEqual([
      {
        externalId: "vk-1",
        externalChatId: "vk-chat"
      }
    ]);
    expect(max.deleteCalls).toHaveLength(0);
    expect(db.socialPublications.find((item) => item.target === "vk")).toMatchObject({
      status: "deleted"
    });
    expect(db.socialPublications.find((item) => item.target === "max")).toMatchObject({
      status: "published"
    });
  });

  it("master social checkbox deletes already published Telegram, VK, and MAX refs", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const [enabled] = parseBitrixWebhook({
      body: {
        element_id: 45,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "Master off"
      }
    });
    const [disabled] = parseBitrixWebhook({
      body: {
        element_id: 45,
        active: "Y",
        publish_social: "N",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        name: "Master off"
      }
    });

    await processBitrixEvent(enabled, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });
    const result = await processBitrixEvent(disabled, {
      db,
      telegram,
      externalPublishers: { vk, max }
    });

    expect(result).toMatchObject({
      status: "deleted",
      reason: "empty_social_value"
    });
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "deleteMessage"
    ]);
    expect(vk.deleteCalls).toHaveLength(1);
    expect(max.deleteCalls).toHaveLength(1);
  });

  it("stores failed external delete state and notifies admin", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const adminNotifier = new FakeMissingScheduleTimeAdminNotifier();
    const vk = new FakeExternalPublisher("vk");
    const [enabled] = parseBitrixWebhook({
      body: {
        element_id: 46,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "N",
          vk: "Y",
          max: "N"
        },
        name: "Delete failure"
      }
    });
    const [disabled] = parseBitrixWebhook({
      body: {
        element_id: 46,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "N",
          vk: "N",
          max: "N"
        },
        name: "Delete failure"
      }
    });

    await processBitrixEvent(enabled, {
      db,
      telegram,
      externalPublishers: { vk }
    });
    vk.failDelete = new Error("VK token lacks wall delete rights");
    const result = await processBitrixEvent(disabled, {
      db,
      telegram,
      externalPublishers: { vk },
      adminNotifier
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("VK token lacks wall delete rights");
    expect(db.socialPublications.find((item) => item.target === "vk")).toMatchObject({
      status: "failed",
      lastError: "VK token lacks wall delete rights"
    });
    expect(adminNotifier.socialPublicationCalls).toEqual([
      {
        bitrixId: 46,
        target: "vk",
        error: "VK token lacks wall delete rights",
        action: "delete"
      }
    ]);
  });
});

function productionPhotos() {
  return [
    {
      id: "253888",
      url: "https://example.com/upload/2026-01-15 19.47.41.jpg",
      path: "/upload/2026-01-15 19.47.41.jpg"
    },
    {
      id: "253889",
      url: "https://example.com/upload/album photo 2.jpg",
      path: "/upload/album photo 2.jpg"
    }
  ];
}

class FakeMissingScheduleTimeAdminNotifier
  implements MissingScheduleTimeAdminNotifier
{
  calls: Array<{
    bitrixId: number;
    sourceField: string | null;
    rawValue: string | null;
    error: string;
  }> = [];
  photoResolutionCalls: Array<{
    bitrixId: number;
    photoIds: string[];
    error: string;
  }> = [];
  socialPublicationCalls: Array<{
    bitrixId: number;
    target: string;
    error: string;
    action: "publish" | "delete";
  }> = [];

  async notifyMissingScheduleTime(input: {
    bitrixId: number;
    sourceField: string | null;
    rawValue: string | null;
    error: string;
  }): Promise<void> {
    this.calls.push(input);
  }

  async notifyPhotoResolutionFailure(input: {
    bitrixId: number;
    photoIds: string[];
    error: string;
  }): Promise<void> {
    this.photoResolutionCalls.push(input);
  }

  async notifySocialPublicationFailure(input: {
    bitrixId: number;
    target: string;
    error: string;
    action: "publish" | "delete";
  }): Promise<void> {
    this.socialPublicationCalls.push(input);
  }
}
