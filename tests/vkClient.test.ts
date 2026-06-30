import { describe, expect, it, vi } from "vitest";
import { VkClient } from "../src/social/vkClient";

describe("VkClient", () => {
  it("publishes a text wall post with the community token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: {
          post_id: 101
        }
      })
    );
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock
    });

    const result = await client.publish({
      bitrixId: 1,
      text: "VK text",
      photos: [],
      payloadHash: "abcdef1234567890"
    });

    expect(result).toMatchObject({
      target: "vk",
      externalId: "101",
      externalChatId: "123",
      publicationKind: "text",
      sentText: "VK text"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.vk.com/method/wall.post"
    );
    const body = bodyParams(fetchMock.mock.calls[0][1]);
    expect(body.get("access_token")).toBe("community-token");
    expect(body.get("owner_id")).toBe("-123");
    expect(body.get("from_group")).toBe("1");
    expect(body.get("message")).toBe("VK text");
    expect(body.get("guid")).toBe("1-abcdef1234567890");
  });

  it("uploads multiple wall photos with user token and publishes attachments", async () => {
    const methodCalls: Array<{ method: string; body: URLSearchParams }> = [];
    let uploadCounter = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.vk.com/method/")) {
        const method = url.split("/").at(-1) ?? "";
        const body = bodyParams(init);
        methodCalls.push({ method, body });

        if (method === "photos.getWallUploadServer") {
          uploadCounter += 1;
          return jsonResponse({
            response: {
              upload_url: `https://vk-upload/${uploadCounter}`
            }
          });
        }

        if (method === "photos.saveWallPhoto") {
          const id = body.get("server") === "1" ? 501 : 502;
          return jsonResponse({
            response: [
              {
                owner_id: -123,
                id,
                access_key: `key-${id}`
              }
            ]
          });
        }

        if (method === "wall.post") {
          return jsonResponse({
            response: {
              post_id: 202
            }
          });
        }
      }

      if (url.startsWith("https://example.com/")) {
        return imageResponse();
      }

      if (url.startsWith("https://vk-upload/")) {
        expect(init?.body).toBeInstanceOf(FormData);
        const server = Number(url.split("/").at(-1));
        return jsonResponse({
          server,
          photo: `photo-json-${server}`,
          hash: `hash-${server}`
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock
    });

    const result = await client.publish({
      bitrixId: 2,
      text: "VK album",
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

    expect(result).toMatchObject({
      externalId: "202",
      publicationKind: "media_group"
    });
    expect(methodCalls.filter((call) => call.method === "photos.getWallUploadServer")).toHaveLength(2);
    expect(methodCalls.filter((call) => call.method === "photos.saveWallPhoto")).toHaveLength(2);
    expect(
      methodCalls
        .filter((call) => call.method.startsWith("photos."))
        .every((call) => call.body.get("access_token") === "user-token")
    ).toBe(true);
    const wallPost = methodCalls.find((call) => call.method === "wall.post");
    expect(wallPost?.body.get("access_token")).toBe("community-token");
    expect(wallPost?.body.get("attachments")).toBe(
      "photo-123_501_key-501,photo-123_502_key-502"
    );
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      "https://example.com/photo%20one.jpg"
    );
  });

  it("requires VK_ACCESS_TOKEN to upload wall photos", async () => {
    const client = new VkClient({
      communityToken: "community-token",
      groupId: "123"
    });

    await expect(
      client.publish({
        bitrixId: 3,
        text: "Needs photo token",
        photos: [
          {
            url: "https://example.com/photo.jpg"
          }
        ],
        payloadHash: "hash"
      })
    ).rejects.toThrow("VK_ACCESS_TOKEN is required to upload wall photos");
  });

  it("deletes a wall post with the community token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        response: 1
      })
    );
    const client = new VkClient({
      communityToken: "community-token",
      groupId: "123",
      fetchImpl: fetchMock
    });

    await client.delete({
      externalId: "101",
      externalChatId: "123"
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.vk.com/method/wall.delete"
    );
    const body = bodyParams(fetchMock.mock.calls[0][1]);
    expect(body.get("access_token")).toBe("community-token");
    expect(body.get("owner_id")).toBe("-123");
    expect(body.get("post_id")).toBe("101");
  });
});

function bodyParams(init?: RequestInit): URLSearchParams {
  if (init?.body instanceof URLSearchParams) {
    return init.body;
  }

  return new URLSearchParams(String(init?.body ?? ""));
}

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
