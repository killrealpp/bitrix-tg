import { describe, expect, it } from "vitest";
import { HttpBitrixPhotoResolver } from "../src/bitrix/photoResolver";

describe("HttpBitrixPhotoResolver", () => {
  it("posts unresolved ids and merges returned URL objects", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    const resolver = new HttpBitrixPhotoResolver({
      endpointUrl: "https://bitrix.example.com/photos/resolve",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : null
        });

        return new Response(
          JSON.stringify({
            photos: [
              {
                id: "253902",
                url: "https://example.com/upload/photo one.jpg",
                path: "/upload/photo one.jpg"
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
    });

    const photos = await resolver.resolvePhotos([
      {
        id: "253902",
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      }
    ]);

    expect(calls).toEqual([
      {
        url: "https://bitrix.example.com/photos/resolve",
        body: JSON.stringify({ ids: ["253902"] })
      }
    ]);
    expect(photos).toEqual([
      {
        id: "253902",
        url: "https://example.com/upload/photo one.jpg",
        path: "/upload/photo one.jpg"
      }
    ]);
  });

  it("does not call the endpoint when all photos already have URLs", async () => {
    const resolver = new HttpBitrixPhotoResolver({
      endpointUrl: "https://bitrix.example.com/photos/resolve",
      fetchImpl: async () => {
        throw new Error("resolver should not be called");
      }
    });
    const photos = [
      {
        id: "253888",
        url: "https://example.com/upload/photo one.jpg",
        path: "/upload/photo one.jpg"
      }
    ];

    await expect(resolver.resolvePhotos(photos)).resolves.toBe(photos);
  });

  it("leaves unresolved photos unresolved when the endpoint returns no URL", async () => {
    const resolver = new HttpBitrixPhotoResolver({
      endpointUrl: "https://bitrix.example.com/photos/resolve",
      fetchImpl: async () =>
        new Response(JSON.stringify({ photos: [{ id: "253902" }] }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
    });
    const input = [
      {
        id: "253902",
        unresolved: true as const,
        unresolvedReason: "bitrix_file_id_without_url" as const
      }
    ];

    await expect(resolver.resolvePhotos(input)).resolves.toEqual(input);
  });

  it("throws a redacted error when the resolver endpoint fails", async () => {
    const resolver = new HttpBitrixPhotoResolver({
      endpointUrl: "https://bitrix.example.com/photos/resolve",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: "authorization: Bearer resolver-secret"
          }),
          {
            status: 500,
            headers: {
              "content-type": "application/json"
            }
          }
        )
    });

    await expect(
      resolver.resolvePhotos([
        {
          id: "253902",
          unresolved: true,
          unresolvedReason: "bitrix_file_id_without_url"
        }
      ])
    ).rejects.toThrow("authorization: Bearer [redacted]");
  });
});
