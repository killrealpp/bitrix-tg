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
      fetchImpl: fetchMock,
      uploadRetryAttempts: 1
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
        expectVkMultipartUpload(init);
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
      fetchImpl: fetchMock,
      uploadRetryAttempts: 1
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
    const firstUpload = fetchMock.mock.calls.find((call) =>
      String(call[0]).startsWith("https://vk-upload/")
    );
    expect(uploadBodyText(firstUpload?.[1])).toContain('filename="photo one.jpg"');
  });

  it("accepts photos_list wall upload responses before saving wall photos", async () => {
    const saveWallPhotoBodies: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/photos.getWallUploadServer")) {
        return jsonResponse({
          response: {
            upload_url: "https://vk-upload/photos-list"
          }
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://vk-upload/photos-list") {
        return jsonResponse({
          server: 1,
          photos_list: "[{\"photo\":\"payload\"}]",
          hash: "hash"
        });
      }

      if (url.endsWith("/photos.saveWallPhoto")) {
        saveWallPhotoBodies.push(bodyParams(init));
        return jsonResponse({
          response: [
            {
              owner_id: -123,
              id: 601
            }
          ]
        });
      }

      if (url.endsWith("/wall.post")) {
        return jsonResponse({
          response: {
            post_id: 203
          }
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock,
      uploadRetryAttempts: 1
    });

    await client.publish({
      bitrixId: 4,
      text: "VK photo",
      photos: [
        {
          url: "https://example.com/photo.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(saveWallPhotoBodies[0].get("photo")).toBe("[{\"photo\":\"payload\"}]");
  });

  it("rejects empty wall photo upload payload before saveWallPhoto", async () => {
    const methodCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.vk.com/method/")) {
        const method = url.split("/").at(-1) ?? "";
        methodCalls.push(method);

        if (method === "photos.getWallUploadServer") {
          return jsonResponse({
            response: {
              upload_url: "https://vk-upload/empty"
            }
          });
        }
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://vk-upload/empty") {
        return jsonResponse({
          server: 7,
          photo: "[]",
          hash: "hash"
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock,
      uploadRetryAttempts: 1
    });

    await expect(
      client.publish({
        bitrixId: 5,
        text: "VK empty upload",
        photos: [
          {
            url: "https://example.com/photo.jpg"
          }
        ],
        payloadHash: "hash"
      })
    ).rejects.toThrow(
      "VK wall photo upload returned empty photo payload (upload response: server=7, hash=present, payloadField=photo, payloadLength=2)"
    );
    expect(methodCalls).toEqual(["photos.getWallUploadServer"]);
  });

  it("retries empty wall photo upload payloads with a fresh upload server", async () => {
    let serverCounter = 0;
    let uploadAttempts = 0;
    const sleepCalls: number[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/photos.getWallUploadServer")) {
        serverCounter += 1;
        return jsonResponse({
          response: {
            upload_url: `https://vk-upload/payload-${serverCounter}`
          }
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url.startsWith("https://vk-upload/payload-")) {
        uploadAttempts += 1;
        expectVkMultipartUpload(init);
        return uploadAttempts === 1
          ? jsonResponse({
              server: 906218,
              photo: "[]",
              hash: "hash-empty"
            })
          : jsonResponse({
              server: 906219,
              photo: "photo-json",
              hash: "hash-ok"
            });
      }

      if (url.endsWith("/photos.saveWallPhoto")) {
        return jsonResponse({
          response: [
            {
              owner_id: -123,
              id: 702
            }
          ]
        });
      }

      if (url.endsWith("/wall.post")) {
        return jsonResponse({
          response: {
            post_id: 205
          }
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      }
    });

    const result = await client.publish({
      bitrixId: 9,
      text: "VK retry empty upload payload",
      photos: [
        {
          url: "https://example.com/photo.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(result.externalId).toBe("205");
    expect(serverCounter).toBe(2);
    expect(uploadAttempts).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it("adds wall photo upload diagnostics when saveWallPhoto fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/photos.getWallUploadServer")) {
        return jsonResponse({
          response: {
            upload_url: "https://vk-upload/invalid-photo"
          }
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://vk-upload/invalid-photo") {
        return jsonResponse({
          server: 9,
          photos_list: "[{\"photo\":\"payload\"}]",
          hash: "hash"
        });
      }

      if (url.endsWith("/photos.saveWallPhoto")) {
        return jsonResponse({
          error: {
            error_code: 100,
            error_msg: "One of the parameters specified was missing or invalid: photos_list is invalid"
          }
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

    await expect(
      client.publish({
        bitrixId: 6,
        text: "VK save fail",
        photos: [
          {
            url: "https://example.com/photo.jpg"
          }
        ],
        payloadHash: "hash"
      })
    ).rejects.toThrow(
      "VK photos.saveWallPhoto failed: 100 One of the parameters specified was missing or invalid: photos_list is invalid (upload response: server=9, hash=present, payloadField=photos_list, payloadLength=21)"
    );
  });

  it("retries transient wall photo upload failures", async () => {
    let uploadAttempts = 0;
    const sleepCalls: number[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/photos.getWallUploadServer")) {
        return jsonResponse({
          response: {
            upload_url: "https://vk-upload/transient"
          }
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://vk-upload/transient") {
        uploadAttempts += 1;
        expectVkMultipartUpload(init);
        return uploadAttempts === 1
          ? jsonResponse({}, 504)
          : jsonResponse({
              server: 1,
              photo: "photo-json",
              hash: "hash"
            });
      }

      if (url.endsWith("/photos.saveWallPhoto")) {
        return jsonResponse({
          response: [
            {
              owner_id: -123,
              id: 701
            }
          ]
        });
      }

      if (url.endsWith("/wall.post")) {
        return jsonResponse({
          response: {
            post_id: 204
          }
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      }
    });

    const result = await client.publish({
      bitrixId: 7,
      text: "VK retry photo",
      photos: [
        {
          url: "https://example.com/photo.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(result.externalId).toBe("204");
    expect(uploadAttempts).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  it("does not retry permanent wall photo upload failures", async () => {
    let uploadAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/photos.getWallUploadServer")) {
        return jsonResponse({
          response: {
            upload_url: "https://vk-upload/permanent"
          }
        });
      }

      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url === "https://vk-upload/permanent") {
        uploadAttempts += 1;
        return jsonResponse({}, 400);
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessToken: "user-token",
      groupId: "123",
      fetchImpl: fetchMock,
      sleep: async () => {
        throw new Error("sleep should not be called");
      }
    });

    await expect(
      client.publish({
        bitrixId: 8,
        text: "VK bad photo",
        photos: [
          {
            url: "https://example.com/photo.jpg"
          }
        ],
        payloadHash: "hash"
      })
    ).rejects.toThrow("VK photo upload failed with HTTP 400");
    expect(uploadAttempts).toBe(1);
  });

  it("refreshes OAuth user token once when VK reports an invalid access token", async () => {
    const methodCalls: Array<{ method: string; token: string | null }> = [];
    const provider = {
      getAccessToken: vi.fn(async () => "old-user-token"),
      refreshAccessToken: vi.fn(async () => "new-user-token")
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://example.com/photo.jpg") {
        return imageResponse();
      }

      if (url.startsWith("https://api.vk.com/method/")) {
        const method = url.split("/").at(-1) ?? "";
        const body = bodyParams(init);
        methodCalls.push({ method, token: body.get("access_token") });

        if (method === "photos.getWallUploadServer") {
          if (body.get("access_token") === "old-user-token") {
            return jsonResponse({
              error: {
                error_code: 5,
                error_msg: "User authorization failed: access token not existed"
              }
            });
          }

          return jsonResponse({
            response: {
              upload_url: "https://vk-upload/refreshed"
            }
          });
        }

        if (method === "photos.saveWallPhoto") {
          return jsonResponse({
            response: [
              {
                owner_id: -123,
                id: 801
              }
            ]
          });
        }

        if (method === "wall.post") {
          return jsonResponse({
            response: {
              post_id: 206
            }
          });
        }
      }

      if (url === "https://vk-upload/refreshed") {
        return jsonResponse({
          server: 1,
          photo: "photo-json",
          hash: "hash"
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new VkClient({
      communityToken: "community-token",
      userAccessTokenProvider: provider,
      groupId: "123",
      fetchImpl: fetchMock,
      uploadRetryAttempts: 1
    });

    const result = await client.publish({
      bitrixId: 10,
      text: "VK refreshed token",
      photos: [
        {
          url: "https://example.com/photo.jpg"
        }
      ],
      payloadHash: "hash"
    });

    expect(result.externalId).toBe("206");
    expect(provider.getAccessToken).toHaveBeenCalledTimes(1);
    expect(provider.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(methodCalls).toEqual([
      { method: "photos.getWallUploadServer", token: "old-user-token" },
      { method: "photos.getWallUploadServer", token: "new-user-token" },
      { method: "photos.saveWallPhoto", token: "new-user-token" },
      { method: "wall.post", token: "community-token" }
    ]);
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

function expectVkMultipartUpload(init?: RequestInit): void {
  const headers = init?.headers as Record<string, string> | undefined;
  expect(headers?.["content-type"]).toMatch(
    /^multipart\/form-data; boundary=----bitrix-tg-vk-/
  );
  expect(Number(headers?.["content-length"])).toBeGreaterThan(0);
  expect(init?.body).toBeInstanceOf(Uint8Array);

  const bodyText = uploadBodyText(init);
  expect(bodyText).toContain('Content-Disposition: form-data; name="photo";');
  expect(bodyText).toContain("Content-Type: image/jpeg");
}

function uploadBodyText(init?: RequestInit): string {
  if (!(init?.body instanceof Uint8Array)) {
    return "";
  }

  return new TextDecoder().decode(init.body);
}
