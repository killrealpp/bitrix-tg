import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBotApiClient } from "../src/telegram/client";

describe("TelegramBotApiClient retry policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries transient Telegram API failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            description: "Internal Server Error"
          },
          500
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            chat: { id: -100 },
            message_id: 42
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken: "test-token",
      chatId: "-100",
      retryAttempts: 2,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    const result = await client.sendText({ text: "hello" });

    expect(result.messageId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent Telegram API failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          description: "Bad Request: chat not found"
        },
        400
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken: "test-token",
      chatId: "-100",
      retryAttempts: 3,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await expect(client.sendText({ text: "hello" })).rejects.toThrow(
      "Telegram sendMessage failed: Bad Request: chat not found"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("encodes photo URLs with spaces before sending media groups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            chat: { id: -100 },
            message_id: 42
          },
          {
            chat: { id: -100 },
            message_id: 43
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken: "test-token",
      chatId: "-100",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await client.sendMediaGroup({
      photos: [
        {
          url: "https://example.com/upload/2026-01-15 19.47.41.jpg"
        },
        {
          url: "https://example.com/upload/album photo 2.jpg"
        }
      ],
      caption: "Album"
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));

    expect(payload.media.map((item: { media: string }) => item.media)).toEqual([
      "https://example.com/upload/2026-01-15%2019.47.41.jpg",
      "https://example.com/upload/album%20photo%202.jpg"
    ]);
  });

  it("redacts the bot token from Telegram API error messages", async () => {
    const botToken = "123456:fake_token";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          description: `Bad Request for https://api.telegram.org/bot${botToken}/sendMessage`
        },
        400
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken,
      chatId: "-100",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    const message = await getThrownMessage(() => client.sendText({ text: "hello" }));

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(botToken);
  });

  it("redacts the bot token and authorization header from network errors", async () => {
    const botToken = "123456:fake_token";
    const fetchMock = vi.fn().mockRejectedValue(
      new Error(
        `fetch failed for https://api.telegram.org/bot${botToken}/sendMessage Authorization: Bearer auth-secret`
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken,
      chatId: "-100",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    const message = await getThrownMessage(() => client.sendText({ text: "hello" }));

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(botToken);
    expect(message).not.toContain("auth-secret");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

async function getThrownMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected action to throw");
}
