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
