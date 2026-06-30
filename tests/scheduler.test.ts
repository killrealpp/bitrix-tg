import { describe, expect, it } from "vitest";
import { parseBitrixWebhook } from "../src/bitrix/parseWebhook";
import { processBitrixEvent } from "../src/poster/processBitrixEvent";
import {
  runDuePosts,
  type ScheduledFailureAdminNotifier
} from "../src/scheduler/runDuePosts";
import {
  FakeBitrixPhotoResolver,
  FakeDbGateway,
  FakeExternalPublisher,
  FakeTelegramClient
} from "./fakes";

describe("scheduled publishing", () => {
  it("stores a future post and publishes it once when due", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 20,
        active: "Y",
        pub_news_social: "2976",
        name: "Future post",
        active_from: "2026-06-04T13:00:00.000Z"
      }
    });

    const scheduled = await processBitrixEvent(event, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });

    expect(scheduled.status).toBe("scheduled");
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0].status).toBe("scheduled");

    const firstRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T12:30:00.000Z")
    });
    expect(firstRun).toEqual({ checked: 0, published: 0, failed: 0 });

    const secondRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(secondRun).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(db.posts[0].status).toBe("published");

    const thirdRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:05:00.000Z")
    });
    expect(thirdRun).toEqual({ checked: 0, published: 0, failed: 0 });
  });

  it("stores and publishes Telegram, VK, and MAX scheduled targets together", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 31,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        post_type: "Акция",
        name: "Future multi-social",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            {
              url: "https://example.com/future.jpg"
            }
          ]
        }
      }
    });

    const scheduled = await processBitrixEvent(event, {
      db,
      telegram,
      externalPublishers: { vk, max },
      textFit: {
        aiPrepare: async () => "Prepared scheduled social post"
      },
      now: new Date("2026-06-04T12:00:00.000Z")
    });
    const result = await runDuePosts({
      db,
      telegram,
      externalPublishers: { vk, max },
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(scheduled.status).toBe("scheduled");
    expect(result).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(max.publishCalls).toHaveLength(1);
    expect(vk.publishCalls[0].text).toBe("Prepared scheduled social post");
    expect(max.publishCalls[0].text).toBe("Prepared scheduled social post");
    expect(db.socialPublications.map((publication) => publication.target).sort()).toEqual([
      "max",
      "telegram",
      "vk"
    ]);
  });

  it("does not duplicate Telegram when a scheduled external target fails and retries", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const vk = new FakeExternalPublisher("vk");
    const max = new FakeExternalPublisher("max");
    vk.failPublish = new Error("VK temporary failure");
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 32,
        active: "Y",
        publish_social: "Y",
        publish_targets: {
          telegram: "Y",
          vk: "Y",
          max: "Y"
        },
        post_type: "Акции",
        name: "Scheduled promo",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            {
              id: "258883",
              url: "https://example.com/promo.jpg"
            }
          ]
        }
      }
    });

    await processBitrixEvent(event, {
      db,
      telegram,
      externalPublishers: { vk, max },
      textFit: {
        aiPrepare: async () => "Prepared promo"
      },
      now: new Date("2026-06-04T12:00:00.000Z")
    });

    const firstRun = await runDuePosts({
      db,
      telegram,
      externalPublishers: { vk, max },
      now: new Date("2026-06-04T13:00:00.000Z"),
      scheduledRetryDelayMs: 60_000
    });

    expect(firstRun).toEqual({ checked: 1, published: 0, failed: 1 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(vk.publishCalls).toHaveLength(1);
    expect(max.publishCalls).toHaveLength(1);
    expect(db.posts[0]).toMatchObject({
      status: "scheduled",
      mainMessageId: 100,
      publicationKind: "photo",
      telegramText: "Prepared promo",
      scheduledRetryCount: 1
    });
    expect(db.socialPublications.find((item) => item.target === "telegram")).toMatchObject({
      status: "published",
      externalId: "100"
    });
    expect(db.socialPublications.find((item) => item.target === "max")).toMatchObject({
      status: "published"
    });
    expect(db.socialPublications.find((item) => item.target === "vk")).toMatchObject({
      status: "failed",
      lastError: "VK temporary failure"
    });

    vk.failPublish = null;
    const secondRun = await runDuePosts({
      db,
      telegram,
      externalPublishers: { vk, max },
      now: new Date("2026-06-04T13:01:00.000Z")
    });

    expect(secondRun).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(vk.publishCalls).toHaveLength(2);
    expect(max.publishCalls).toHaveLength(1);
    expect(db.posts[0].status).toBe("published");
    expect(db.socialPublications.find((item) => item.target === "vk")).toMatchObject({
      status: "published"
    });
  });

  it("resolves stored Bitrix photo ids before publishing due scheduled posts", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const photoResolver = new FakeBitrixPhotoResolver({
      "253902": {
        id: "253902",
        url: "https://example.com/upload/scheduled photo.jpg",
        path: "/upload/scheduled photo.jpg"
      }
    });
    await db.createPost({
      bitrixId: 25,
      status: "scheduled",
      scheduledAt: new Date("2026-06-04T13:00:00.000Z"),
      sourceText: "Scheduled photo",
      photos: [
        {
          id: "253902",
          unresolved: true,
          unresolvedReason: "bitrix_file_id_without_url"
        }
      ],
      payloadHash: "hash"
    });

    const result = await runDuePosts({
      db,
      telegram,
      photoResolver,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(result).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(photoResolver.calls).toHaveLength(1);
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(db.posts[0].photos).toEqual([
      {
        id: "253902",
        url: "https://example.com/upload/scheduled photo.jpg",
        path: "/upload/scheduled photo.jpg"
      }
    ]);
    expect(db.messages[0].mediaUrl).toBe(
      "https://example.com/upload/scheduled photo.jpg"
    );
  });

  it("publishes due scheduled posts with direct production photo URLs", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 26,
        active: "Y",
        pub_news_social: "2976",
        name: "Scheduled album",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            {
              id: "253901",
              url: "https://example.com/upload/one.jpg",
              path: "/upload/one.jpg"
            },
            {
              id: "253902",
              url: "https://example.com/upload/two with spaces.jpg",
              path: "/upload/two with spaces.jpg"
            }
          ]
        }
      }
    });

    const scheduled = await processBitrixEvent(event, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });
    const result = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(scheduled.status).toBe("scheduled");
    expect(result).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/one.jpg",
      "https://example.com/upload/two with spaces.jpg"
    ]);
  });

  it("publishes multiple due scheduled posts in the same worker run", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 28,
        active: "Y",
        pub_news_social: "2976",
        name: "Queued text",
        active_from: "2026-06-04T13:00:00.000Z"
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 29,
        active: "Y",
        pub_news_social: "2976",
        name: "Queued album",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            { url: "https://example.com/queued-a.jpg" },
            { url: "https://example.com/queued-b.jpg" }
          ]
        }
      }
    });

    await processBitrixEvent(first, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });
    await processBitrixEvent(second, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });

    const result = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(result).toEqual({ checked: 2, published: 2, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual([
      "sendText",
      "sendMediaGroup"
    ]);
    expect(db.posts.map((post) => post.status)).toEqual([
      "published",
      "published"
    ]);
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      null,
      "https://example.com/queued-a.jpg",
      "https://example.com/queued-b.jpg"
    ]);
  });

  it("fits long due scheduled text before Telegram publication", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const aiCalls: unknown[] = [];
    await db.createPost({
      bitrixId: 30,
      status: "scheduled",
      scheduledAt: new Date("2026-06-04T13:00:00.000Z"),
      sourceText: "Long scheduled ".repeat(400),
      photos: [],
      payloadHash: "hash"
    });

    const result = await runDuePosts({
      db,
      telegram,
      textFit: {
        aiFit: async (request) => {
          aiCalls.push(request);
          return "AI fitted scheduled text";
        }
      },
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(result).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(aiCalls).toHaveLength(1);
    expect(telegram.calls[0].input).toMatchObject({
      text: "AI fitted scheduled text"
    });
    expect(db.posts[0].telegramText).toBe("AI fitted scheduled text");
  });

  it("publishes the latest text and photos when a scheduled post is edited before it is due", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [first] = parseBitrixWebhook({
      body: {
        element_id: 27,
        active: "Y",
        pub_news_social: "2976",
        name: "Scheduled old text",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            {
              id: "old",
              url: "https://example.com/upload/old.jpg",
              path: "/upload/old.jpg"
            }
          ]
        }
      }
    });
    const [second] = parseBitrixWebhook({
      body: {
        element_id: 27,
        active: "Y",
        pub_news_social: "2976",
        name: "Scheduled latest text",
        active_from: "2026-06-04T13:00:00.000Z",
        all_properties: {
          PHOTOS: [
            {
              id: "new-1",
              url: "https://example.com/upload/new 1.jpg",
              path: "/upload/new 1.jpg"
            },
            {
              id: "new-2",
              url: "https://example.com/upload/new 2.jpg",
              path: "/upload/new 2.jpg"
            }
          ]
        }
      }
    });

    await processBitrixEvent(first, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });
    const updated = await processBitrixEvent(second, {
      db,
      telegram,
      now: new Date("2026-06-04T12:30:00.000Z")
    });
    expect(updated.status).toBe("scheduled");
    expect(telegram.calls).toHaveLength(0);

    const result = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(result).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.posts[0].sourceText).toBe("Scheduled latest text");
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/new 1.jpg",
      "https://example.com/upload/new 2.jpg"
    ]);
  });

  it("cancels a pending scheduled post when Bitrix later marks it inactive", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const [scheduledEvent] = parseBitrixWebhook({
      body: {
        element_id: 21,
        active: "Y",
        pub_news_social: "2976",
        name: "Future post",
        active_from: "2026-06-04T13:00:00.000Z"
      }
    });
    const [inactiveEvent] = parseBitrixWebhook({
      body: {
        element_id: 21,
        active: "N",
        pub_news_social: "2976",
        name: "Future post",
        active_from: "2026-06-04T13:00:00.000Z"
      }
    });

    await processBitrixEvent(scheduledEvent, {
      db,
      telegram,
      now: new Date("2026-06-04T12:00:00.000Z")
    });
    const ignored = await processBitrixEvent(inactiveEvent, {
      db,
      telegram,
      now: new Date("2026-06-04T12:05:00.000Z")
    });
    const dueRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(ignored).toMatchObject({
      status: "ignored",
      reason: "inactive"
    });
    expect(db.posts[0].status).toBe("ignored");
    expect(db.posts[0].scheduledAt).toBeNull();
    expect(dueRun).toEqual({ checked: 0, published: 0, failed: 0 });
    expect(telegram.calls).toHaveLength(0);
  });

  it("reschedules a failed due post once for 5 minutes later", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const originalSendText = telegram.sendText.bind(telegram);
    let shouldFail = true;
    telegram.sendText = async (input) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Temporary scheduled failure");
      }

      return originalSendText(input);
    };
    await db.createPost({
      bitrixId: 23,
      status: "scheduled",
      scheduledAt: new Date("2026-06-04T13:00:00.000Z"),
      sourceText: "Scheduled retry",
      photos: [],
      payloadHash: "hash"
    });

    const firstRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z")
    });

    expect(firstRun).toEqual({ checked: 1, published: 0, failed: 1 });
    expect(db.posts[0].status).toBe("scheduled");
    expect(db.posts[0].scheduledRetryCount).toBe(1);
    expect(db.posts[0].scheduledAt?.toISOString()).toBe(
      "2026-06-04T13:05:00.000Z"
    );
    expect(db.posts[0].lastError).toBe("Temporary scheduled failure");

    const earlyRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:04:59.000Z")
    });
    expect(earlyRun).toEqual({ checked: 0, published: 0, failed: 0 });

    const retryRun = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:05:00.000Z")
    });
    expect(retryRun).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(db.posts[0].status).toBe("published");
    expect(db.posts[0].scheduledRetryCount).toBe(0);
  });

  it("notifies an admin after the scheduled retry also fails", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const adminNotifier = new FakeAdminNotifier();
    telegram.sendText = async () => {
      throw new Error("Still failing");
    };
    await db.createPost({
      bitrixId: 24,
      status: "scheduled",
      scheduledAt: new Date("2026-06-04T13:05:00.000Z"),
      sourceText: "Scheduled final failure",
      photos: [],
      payloadHash: "hash",
      scheduledRetryCount: 1
    });

    const result = await runDuePosts({
      db,
      telegram,
      adminNotifier,
      now: new Date("2026-06-04T13:05:00.000Z")
    });

    expect(result).toEqual({ checked: 1, published: 0, failed: 1 });
    expect(db.posts[0].status).toBe("failed");
    expect(db.posts[0].lastError).toBe("Still failing");
    expect(db.posts[0].adminNotifiedAt?.toISOString()).toBe(
      "2026-06-04T13:05:00.000Z"
    );
    expect(adminNotifier.calls).toEqual([
      {
        bitrixId: 24,
        error: "Still failing",
        retryCount: 1
      }
    ]);
  });

  it("redacts secret-shaped values before storing failed scheduled errors", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    telegram.sendText = async () => {
      throw new Error(
        "Scheduled send failed with TELEGRAM_BOT_TOKEN=123456:fake_token authorization: Bearer auth-secret"
      );
    };
    await db.createPost({
      bitrixId: 22,
      status: "scheduled",
      scheduledAt: new Date("2026-06-04T13:00:00.000Z"),
      sourceText: "Scheduled failure",
      photos: [],
      payloadHash: "hash"
    });

    const result = await runDuePosts({
      db,
      telegram,
      now: new Date("2026-06-04T13:00:00.000Z"),
      maxScheduledRetries: 0
    });

    expect(result).toEqual({ checked: 1, published: 0, failed: 1 });
    expect(db.posts[0].status).toBe("failed");
    expect(db.posts[0].lastError).toContain("[redacted]");
    expect(db.posts[0].lastError).not.toContain("123456:fake_token");
    expect(db.posts[0].lastError).not.toContain("auth-secret");
  });
});

class FakeAdminNotifier implements ScheduledFailureAdminNotifier {
  calls: Array<{ bitrixId: number; error: string; retryCount: number }> = [];

  async notifyScheduledPublishFailure(input: {
    bitrixId: number;
    error: string;
    retryCount: number;
  }): Promise<void> {
    this.calls.push(input);
  }
}
