import { describe, expect, it, vi } from "vitest";
import { MaxClient } from "../src/social/maxClient";

describe("MaxClient", () => {
  it("publishes a text message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        message: {
          id: "max-message-1"
        }
      })
    );
    const client = new MaxClient({
      token: "max-secret",
      chatId: "max-chat",
      fetchImpl: fetchMock
    });

    const result = await client.publish({
      bitrixId: 1,
      text: "Hello MAX",
      photos: [],
      payloadHash: "hash"
    });

    expect(result).toMatchObject({
      target: "max",
      externalId: "max-message-1",
      externalChatId: "max-chat",
      publicationKind: "text",
      sentText: "Hello MAX"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://platform-api2.max.ru/messages?chat_id=max-chat"
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "max-secret",
        "content-type": "application/json"
      }
    });
  });

  it("uploads multiple images and sends them as message attachments", async () => {
    const messageBodies: unknown[] = [];
    let uploadCounter = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://platform-api2.max.ru/uploads?type=image") {
        uploadCounter += 1;
        return jsonResponse({
          url: `https://upload.max/${uploadCounter}`
        });
      }

      if (url.startsWith("https://example.com/")) {
        return imageResponse();
      }

      if (url.startsWith("https://upload.max/")) {
        const uploadId = url.split("/").at(-1);
        expect(init?.body).toBeInstanceOf(FormData);
        return jsonResponse({
          token: `image-token-${uploadId}`
        });
      }

      if (url === "https://platform-api2.max.ru/messages?chat_id=max-chat") {
        messageBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          message: {
            id: "max-message-photos"
          }
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new MaxClient({
      token: "max-secret",
      chatId: "max-chat",
      fetchImpl: fetchMock
    });

    const result = await client.publish({
      bitrixId: 2,
      text: "Album",
      photos: [
        {
          url: "https://example.com/photo one.jpg"
        },
        {
          url: "https://example.com/photo two.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(result.publicationKind).toBe("media_group");
    expect(messageBodies).toEqual([
      {
        text: "Album",
        attachments: [
          {
            type: "image",
            payload: {
              token: "image-token-1"
            }
          },
          {
            type: "image",
            payload: {
              token: "image-token-2"
            }
          }
        ]
      }
    ]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "https://example.com/photo%20one.jpg"
    );
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "https://example.com/photo%20two.jpg"
    );
  });

  it("retries message send when MAX reports attachment.not.ready", async () => {
    let sendAttempts = 0;
    const sleepCalls: number[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://platform-api2.max.ru/uploads?type=image") {
        return jsonResponse({
          url: "https://upload.max/ready"
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://upload.max/ready") {
        return jsonResponse({
          token: "image-token"
        });
      }

      if (url === "https://platform-api2.max.ru/messages?chat_id=max-chat") {
        sendAttempts += 1;
        return sendAttempts === 1
          ? jsonResponse({ code: "attachment.not.ready" })
          : jsonResponse({
              message: {
                id: "max-after-retry"
              }
            });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new MaxClient({
      token: "max-secret",
      chatId: "max-chat",
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      }
    });

    const result = await client.publish({
      bitrixId: 3,
      text: "Retry image",
      photos: [
        {
          url: "https://example.com/photo.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(result.externalId).toBe("max-after-retry");
    expect(sendAttempts).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it("deletes a MAX message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    const client = new MaxClient({
      token: "max-secret",
      chatId: "max-chat",
      fetchImpl: fetchMock
    });

    await client.delete({
      externalId: "max-message-1",
      externalChatId: "max-chat"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform-api2.max.ru/messages/max-message-1?chat_id=max-chat",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          authorization: "max-secret"
        }
      })
    );
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

function imageResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {
      "content-type": "image/jpeg"
    }
  });
}
