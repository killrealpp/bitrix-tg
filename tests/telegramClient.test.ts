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
      photoDeliveryMode: "url",
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

  it("uploads a photo file when Telegram cannot fetch the photo URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            description: "Bad Request: failed to get HTTP URL content"
          },
          400
        )
      )
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            chat: { id: -100 },
            message_id: 42,
            photo: [{ file_id: "file-small" }, { file_id: "file-large" }]
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramBotApiClient({
      botToken: "test-token",
      chatId: "-100",
      photoDeliveryMode: "auto",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    const result = await client.sendPhoto({
      photo: {
        url: "https://example.com/upload/photo one.jpg"
      },
      caption: "Caption"
    });

    expect(result.messageId).toBe(42);
    expect(result.telegramFileId).toBe("file-large");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://example.com/upload/photo%20one.jpg"
    );

    const request = fetchMock.mock.calls[2][1] as RequestInit;
    const form = request.body as FormData;

    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("caption")).toBe("Caption");
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("uploads photo files by default without passing URLs to Telegram first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
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
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await client.sendPhoto({
      photo: {
        url: "https://example.com/upload/photo one.jpg"
      },
      caption: "Caption"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/upload/photo%20one.jpg"
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain("/sendPhoto");

    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.body).toBeInstanceOf(FormData);
  });

  it("uploads media group files when Telegram cannot fetch photo URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            description: "Bad Request: wrong file identifier/HTTP URL specified"
          },
          400
        )
      )
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
      .mockResolvedValueOnce(imageResponse("image/png"))
      .mockResolvedValueOnce(
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
      photoDeliveryMode: "auto",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await client.sendMediaGroup({
      photos: [
        {
          url: "https://example.com/upload/photo one.jpg"
        },
        {
          url: "https://example.com/upload/photo two.png"
        }
      ],
      caption: "Album"
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://example.com/upload/photo%20one.jpg"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://example.com/upload/photo%20two.png"
    );

    const request = fetchMock.mock.calls[3][1] as RequestInit;
    const form = request.body as FormData;
    const media = JSON.parse(String(form.get("media")));

    expect(media).toEqual([
      {
        type: "photo",
        media: "attach://photo_0",
        caption: "Album"
      },
      {
        type: "photo",
        media: "attach://photo_1"
      }
    ]);
    expect(form.get("photo_0")).toBeInstanceOf(Blob);
    expect(form.get("photo_1")).toBeInstanceOf(Blob);
  });

  it("uploads media group files by default without passing URLs to Telegram first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
      .mockResolvedValueOnce(imageResponse("image/png"))
      .mockResolvedValueOnce(
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
          url: "https://example.com/upload/photo one.jpg"
        },
        {
          url: "https://example.com/upload/photo two.png"
        }
      ],
      caption: "Album"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/upload/photo%20one.jpg"
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://example.com/upload/photo%20two.png"
    );
    expect(String(fetchMock.mock.calls[2][0])).toContain("/sendMediaGroup");

    const request = fetchMock.mock.calls[2][1] as RequestInit;
    const form = request.body as FormData;
    const media = JSON.parse(String(form.get("media")));

    expect(media).toEqual([
      {
        type: "photo",
        media: "attach://photo_0",
        caption: "Album"
      },
      {
        type: "photo",
        media: "attach://photo_1"
      }
    ]);
    expect(form.get("photo_0")).toBeInstanceOf(Blob);
    expect(form.get("photo_1")).toBeInstanceOf(Blob);
  });

  it("uploads a replacement media file when Telegram cannot fetch the edit URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            description: "Bad Request: failed to get HTTP URL content"
          },
          400
        )
      )
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
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
      photoDeliveryMode: "auto",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await client.editMedia({
      chatId: "-100",
      messageId: 42,
      photo: {
        url: "https://example.com/upload/new photo.jpg"
      },
      caption: "Updated"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const request = fetchMock.mock.calls[2][1] as RequestInit;
    const form = request.body as FormData;
    const media = JSON.parse(String(form.get("media")));

    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("message_id")).toBe("42");
    expect(media).toEqual({
      type: "photo",
      media: "attach://photo",
      caption: "Updated"
    });
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("uploads replacement media by default without passing the URL to Telegram first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(imageResponse("image/jpeg"))
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
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await client.editMedia({
      chatId: "-100",
      messageId: 42,
      photo: {
        url: "https://example.com/upload/new photo.jpg"
      },
      caption: "Updated"
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/upload/new%20photo.jpg"
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain("/editMessageMedia");

    const request = fetchMock.mock.calls[1][1] as RequestInit;
    const form = request.body as FormData;
    const media = JSON.parse(String(form.get("media")));

    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("message_id")).toBe("42");
    expect(media).toEqual({
      type: "photo",
      media: "attach://photo",
      caption: "Updated"
    });
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("does not download photos for non-URL Telegram errors", async () => {
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
      photoDeliveryMode: "auto",
      retryAttempts: 1,
      retryDelayMs: 0,
      sleep: async () => {}
    });

    await expect(
      client.sendPhoto({
        photo: {
          url: "https://example.com/upload/photo.jpg"
        }
      })
    ).rejects.toThrow("Telegram sendPhoto failed: Bad Request: chat not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

function imageResponse(contentType: string): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    headers: {
      "content-type": contentType
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
