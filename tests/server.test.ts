import { describe, expect, it } from "vitest";
import { LOG_REDACT_PATHS, buildApp } from "../src/server";
import { runDuePosts } from "../src/scheduler/runDuePosts";
import {
  FakeBitrixPhotoResolver,
  FakeDbGateway,
  FakeTelegramClient
} from "./fakes";

describe("server", () => {
  it("configures request log redaction for webhook secrets", () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-webhook-secret"]');
    expect(LOG_REDACT_PATHS).toContain("req.headers.authorization");
  });

  it("returns OK from /health", async () => {
    const app = buildApp({
      db: new FakeDbGateway(),
      telegram: new FakeTelegramClient(),
      config: {}
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("OK");
    await app.close();
  });

  it("processes a Bitrix webhook through POST /webhooks/bitrix", async () => {
    const app = buildApp({
      db: new FakeDbGateway(),
      telegram: new FakeTelegramClient(),
      config: {}
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            element_id: 9,
            active: "Y",
            pub_news_social: "2976",
            name: "Hello"
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      published: 1,
      ignored: 0
    });
    await app.close();
  });

  it("passes the configured photo resolver through the webhook route", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const photoResolver = new FakeBitrixPhotoResolver({
      "253902": {
        id: "253902",
        url: "https://example.com/upload/resolved.jpg",
        path: "/upload/resolved.jpg"
      }
    });
    const app = buildApp({
      db,
      telegram,
      photoResolver,
      config: {}
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            element_id: 13,
            active: "Y",
            pub_news_social: "2976",
            name: "Photo id",
            all_properties: {
              PHOTOS: "253902"
            }
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      published: 1
    });
    expect(photoResolver.calls).toHaveLength(1);
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(db.posts[0].photos[0].url).toBe(
      "https://example.com/upload/resolved.jpg"
    );
    await app.close();
  });

  it("uses configured Bitrix active-from field in the webhook route", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const app = buildApp({
      db,
      telegram,
      config: {
        bitrixActiveFromField: "all_properties.CUSTOM_ACTIVE_FROM"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            element_id: 10,
            active: "Y",
            pub_news_social: "2976",
            name: "Scheduled",
            all_properties: {
              CUSTOM_ACTIVE_FROM: "2999-01-01T00:00:00.000Z"
            }
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      scheduled: 1
    });
    expect(db.posts[0].scheduledAt?.toISOString()).toBe(
      "2999-01-01T00:00:00.000Z"
    );
    expect(telegram.calls).toHaveLength(0);
    await app.close();
  });

  it("requires active_from through the webhook route when configured", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const app = buildApp({
      db,
      telegram,
      config: {
        bitrixRequireExactActiveFrom: true
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            element_id: 14,
            active: "Y",
            pub_news_social: "2976",
            name: "Missing time"
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      failed: 1
    });
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0]).toMatchObject({
      bitrixId: 14,
      status: "failed"
    });
    await app.close();
  });

  it("applies the configured Bitrix local UTC offset in the webhook route", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const app = buildApp({
      db,
      telegram,
      config: {
        bitrixLocalUtcOffsetMinutes: 180
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            element_id: 15,
            active: "Y",
            pub_news_social: "2976",
            name: "Scheduled local time",
            active_from: "04.06.2999 13:00:00"
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      scheduled: 1
    });
    expect(db.posts[0].scheduledAt?.toISOString()).toBe(
      "2999-06-04T10:00:00.000Z"
    );
    expect(telegram.calls).toHaveLength(0);
    await app.close();
  });

  it("stores production photo arrays through the webhook route and publishes them when due", async () => {
    const db = new FakeDbGateway();
    const telegram = new FakeTelegramClient();
    const app = buildApp({
      db,
      telegram,
      config: {
        bitrixRequireExactActiveFrom: true,
        bitrixLocalUtcOffsetMinutes: 180
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            action: "update",
            element_id: 16,
            active: "Y",
            pub_news_social: "2976",
            name: "Scheduled production album",
            detail_text: "Album body",
            active_from: "04.06.2999 13:00:00",
            all_properties: {
              PHOTOS: [
                {
                  id: "253901",
                  url: "https://example.com/upload/image.png",
                  path: "/upload/image.png"
                },
                {
                  id: "253902",
                  url: "https://example.com/upload/2026-01-15 19.47.41.jpg",
                  path: "/upload/2026-01-15 19.47.41.jpg"
                }
              ]
            }
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      scheduled: 1
    });
    expect(telegram.calls).toHaveLength(0);
    expect(db.posts[0].photos).toHaveLength(2);
    expect(db.posts[0].scheduledAt?.toISOString()).toBe(
      "2999-06-04T10:00:00.000Z"
    );

    const due = await runDuePosts({
      db,
      telegram,
      now: new Date("2999-06-04T10:00:00.000Z")
    });

    expect(due).toEqual({ checked: 1, published: 1, failed: 0 });
    expect(telegram.calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(db.posts[0].publicationKind).toBe("media_group");
    expect(db.messages.map((message) => message.mediaUrl)).toEqual([
      "https://example.com/upload/image.png",
      "https://example.com/upload/2026-01-15 19.47.41.jpg"
    ]);
    await app.close();
  });

  it("rejects webhooks with the wrong shared secret", async () => {
    const app = buildApp({
      db: new FakeDbGateway(),
      telegram: new FakeTelegramClient(),
      config: {
        webhookSecret: "expected"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      headers: {
        "x-webhook-secret": "wrong"
      },
      payload: []
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: "unauthorized"
    });
    await app.close();
  });

  it("accepts webhooks with the configured shared secret", async () => {
    const app = buildApp({
      db: new FakeDbGateway(),
      telegram: new FakeTelegramClient(),
      config: {
        webhookSecret: "expected"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      headers: {
        "x-webhook-secret": "expected"
      },
      payload: [
        {
          body: {
            element_id: 11,
            active: "Y",
            pub_news_social: "2976",
            name: "Authorized"
          }
        }
      ]
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      processed: 1,
      published: 1
    });
    await app.close();
  });

  it("does not return raw unhandled error details from the webhook route", async () => {
    class ThrowingDbGateway extends FakeDbGateway {
      override async findPostByBitrixId(_bitrixId: number) {
        throw new Error(
          "database failed with TELEGRAM_BOT_TOKEN=123456:fake_token authorization: Bearer auth-secret WEBHOOK_SECRET=hook-secret"
        );
      }
    }

    const app = buildApp({
      db: new ThrowingDbGateway(),
      telegram: new FakeTelegramClient(),
      config: {
        telegramBotToken: "123456:fake_token",
        webhookSecret: "hook-secret"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      headers: {
        "x-webhook-secret": "hook-secret"
      },
      payload: [
        {
          body: {
            element_id: 12,
            active: "Y",
            pub_news_social: "2976",
            name: "Unhandled failure"
          }
        }
      ]
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "internal_error"
    });
    expect(response.body).not.toContain("123456:fake_token");
    expect(response.body).not.toContain("auth-secret");
    expect(response.body).not.toContain("hook-secret");
    await app.close();
  });
});
