import { describe, expect, it } from "vitest";
import {
  BitrixWebhookParseError,
  parseBitrixWebhook
} from "../src/bitrix/parseWebhook";
import { buildTelegramSourceText } from "../src/text/buildText";

describe("parseBitrixWebhook", () => {
  it("parses an n8n envelope and normalizes one PHOTOS object to an array", () => {
    const [event] = parseBitrixWebhook([
      {
        body: {
          action: "update",
          element_id: "181692",
          active: "Y",
          name: "Title",
          preview_text: "Preview",
          detail_text: "Detail",
          pub_news_social: "2976",
          all_properties: {
            PHOTOS: {
              id: "253888",
              url: "https://example.com/photo one.jpg",
              path: "/upload/photo one.jpg"
            }
          }
        }
      }
    ]);

    expect(event.bitrixId).toBe(181692);
    expect(event.isActive).toBe(true);
    expect(event.socialValue).toBe("2976");
    expect(event.photos).toEqual([
      {
        id: "253888",
        url: "https://example.com/photo one.jpg",
        path: "/upload/photo one.jpg"
      }
    ]);
    expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves production PHOTOS arrays with id, url, and path", () => {
    const [event] = parseBitrixWebhook([
      {
        body: {
          action: "update",
          element_id: "181696",
          active: "Y",
          name: "Album",
          pub_news_social: "2976",
          all_properties: {
            PHOTOS: [
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
            ]
          }
        }
      }
    ]);

    expect(event.photos).toEqual([
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
    ]);
  });

  it("normalizes Bitrix/PHP uppercase photo objects with SRC fields", () => {
    const [event] = parseBitrixWebhook({
      body: {
        action: "update",
        element_id: "181697",
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS: [
            {
              ID: "253901",
              SRC: "https://example.com/upload/photo one.jpg",
              PATH: "/upload/photo one.jpg"
            },
            {
              FILE_ID: "253902",
              URL: "https://example.com/upload/photo two.jpg",
              PATH: "/upload/photo two.jpg"
            }
          ]
        }
      }
    });

    expect(event.photos).toEqual([
      {
        id: "253901",
        url: "https://example.com/upload/photo one.jpg",
        path: "/upload/photo one.jpg"
      },
      {
        id: "253902",
        url: "https://example.com/upload/photo two.jpg",
        path: "/upload/photo two.jpg"
      }
    ]);
  });

  it("normalizes Bitrix property wrappers with VALUE photos", () => {
    const [event] = parseBitrixWebhook({
      body: {
        action: "update",
        element_id: "181698",
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS: {
            VALUE: [
              {
                ID: "253901",
                SRC: "https://example.com/upload/a.jpg"
              },
              {
                ID: "253902",
                SRC: "https://example.com/upload/b.jpg"
              }
            ]
          }
        }
      }
    });

    expect(event.photos).toEqual([
      {
        id: "253901",
        url: "https://example.com/upload/a.jpg",
        path: undefined
      },
      {
        id: "253902",
        url: "https://example.com/upload/b.jpg",
        path: undefined
      }
    ]);
  });

  it("normalizes Bitrix object maps with numeric property keys", () => {
    const [event] = parseBitrixWebhook({
      body: {
        action: "update",
        element_id: "181699",
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS: {
            "0": {
              id: "253901",
              url: "https://example.com/upload/a.jpg"
            },
            "1": {
              id: "253902",
              url: "https://example.com/upload/b.jpg"
            }
          }
        }
      }
    });

    expect(event.photos).toEqual([
      {
        id: "253901",
        url: "https://example.com/upload/a.jpg",
        path: undefined
      },
      {
        id: "253902",
        url: "https://example.com/upload/b.jpg",
        path: undefined
      }
    ]);
  });

  it("uses preview/detail picture fallback when PHOTOS is absent", () => {
    const [event] = parseBitrixWebhook({
      body: {
        action: "update",
        element_id: "181700",
        active: "Y",
        pub_news_social: "2976",
        preview_picture: {
          ID: "253901",
          SRC: "https://example.com/upload/preview.jpg"
        }
      }
    });

    expect(event.photos).toEqual([
      {
        id: "253901",
        url: "https://example.com/upload/preview.jpg",
        path: undefined
      }
    ]);
  });

  it("normalizes JSON-string and comma-separated photo id payloads", () => {
    const [jsonEvent] = parseBitrixWebhook({
      body: {
        element_id: 181701,
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS:
            '[{"id":"253901","url":"https://example.com/upload/a.jpg"}]'
        }
      }
    });
    const [idEvent] = parseBitrixWebhook({
      body: {
        element_id: 181702,
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS: "253901,253902"
        }
      }
    });

    expect(jsonEvent.photos).toEqual([
      {
        id: "253901",
        url: "https://example.com/upload/a.jpg",
        path: undefined
      }
    ]);
    expect(idEvent.photos).toEqual([
      {
        id: "253901",
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      },
      {
        id: "253902",
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      }
    ]);
  });

  it("falls back to all_properties.pub_news_social and removes empty photos", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 7,
        active: "N",
        pub_news_social: "",
        all_properties: {
          pub_news_social: "telegram",
          PHOTOS: [null, { url: "" }, { url: "https://example.com/a.jpg" }]
        }
      }
    });

    expect(event.isActive).toBe(false);
    expect(event.socialValue).toBe("telegram");
    expect(event.photos).toHaveLength(1);
  });

  it("keeps Bitrix file id strings as unresolved photos", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 46,
        active: "Y",
        pub_news_social: "2976",
        all_properties: {
          PHOTOS: "253902"
        }
      }
    });

    expect(event.photos).toEqual([
      {
        id: "253902",
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      }
    ]);
  });

  it("computes the same hash for repeated identical normalized payloads", () => {
    const payload = {
      body: {
        element_id: 42,
        active: "Y",
        pub_news_social: "2976",
        name: "Same"
      }
    };

    const [first] = parseBitrixWebhook(payload);
    const [second] = parseBitrixWebhook(payload);

    expect(first.payloadHash).toBe(second.payloadHash);
  });

  it("parses Bitrix activity start aliases and dd.mm.yyyy dates", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 43,
        active: "Y",
        pub_news_social: "2976",
        DATE_ACTIVE_FROM: "04.06.2026 13:45:30"
      }
    });

    expect(event.scheduledAtSourceField).toBe("DATE_ACTIVE_FROM");
    expect(event.scheduledAtRawValue).toBe("04.06.2026 13:45:30");
    expect(event.scheduledAtPrecision).toBe("datetime");
    expect(event.scheduledAt?.getFullYear()).toBe(2026);
    expect(event.scheduledAt?.getMonth()).toBe(5);
    expect(event.scheduledAt?.getDate()).toBe(4);
    expect(event.scheduledAt?.getHours()).toBe(13);
    expect(event.scheduledAt?.getMinutes()).toBe(45);
    expect(event.scheduledAt?.getSeconds()).toBe(30);
  });

  it("parses Bitrix local activity start with a configured UTC offset", () => {
    const [bitrixDateEvent] = parseBitrixWebhook(
      {
        body: {
          element_id: 48,
          active: "Y",
          pub_news_social: "2976",
          active_from: "04.06.2026 13:45:30"
        }
      },
      {
        activeFromUtcOffsetMinutes: 180
      }
    );
    const [isoLikeEvent] = parseBitrixWebhook(
      {
        body: {
          element_id: 49,
          active: "Y",
          pub_news_social: "2976",
          active_from: "2026-06-04 13:45:30"
        }
      },
      {
        activeFromUtcOffsetMinutes: 180
      }
    );

    expect(bitrixDateEvent.scheduledAt?.toISOString()).toBe(
      "2026-06-04T10:45:30.000Z"
    );
    expect(isoLikeEvent.scheduledAt?.toISOString()).toBe(
      "2026-06-04T10:45:30.000Z"
    );
  });

  it("keeps invalid activity start source details for admin notifications", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 50,
        active: "Y",
        pub_news_social: "2976",
        active_from: "not a date"
      }
    });

    expect(event.scheduledAt).toBeNull();
    expect(event.scheduledAtSourceField).toBe("active_from");
    expect(event.scheduledAtRawValue).toBe("not a date");
    expect(event.scheduledAtPrecision).toBeNull();
  });

  it("marks date-only Bitrix activity start as lacking exact time", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 47,
        active: "Y",
        pub_news_social: "2976",
        active_from: "11.06.2026"
      }
    });

    expect(event.scheduledAtSourceField).toBe("active_from");
    expect(event.scheduledAtRawValue).toBe("11.06.2026");
    expect(event.scheduledAtPrecision).toBe("date");
    expect(event.scheduledAt?.getFullYear()).toBe(2026);
    expect(event.scheduledAt?.getMonth()).toBe(5);
    expect(event.scheduledAt?.getDate()).toBe(11);
  });

  it("uses configured nested activity start field paths", () => {
    const [event] = parseBitrixWebhook(
      {
        body: {
          element_id: 44,
          active: "Y",
          pub_news_social: "2976",
          all_properties: {
            CUSTOM_ACTIVE_FROM: "2026-06-04T13:00:00.000Z"
          }
        }
      },
      {
        activeFromField: "all_properties.CUSTOM_ACTIVE_FROM"
      }
    );

    expect(event.scheduledAtSourceField).toBe("all_properties.CUSTOM_ACTIVE_FROM");
    expect(event.scheduledAt?.toISOString()).toBe("2026-06-04T13:00:00.000Z");
  });

  it("normalizes uppercase Bitrix text fields into plain Telegram text", () => {
    const [event] = parseBitrixWebhook({
      body: {
        element_id: 45,
        ACTIVE: "Y",
        PUB_NEWS_SOCIAL: "2976",
        NAME: "Title &amp; Co",
        PREVIEW_TEXT: "<p>Lead<br>line</p>",
        DETAIL_TEXT: "<div>Detail&nbsp;text</div>"
      }
    });

    expect(buildTelegramSourceText(event)).toBe(
      "Title & Co\n\nLead\nline\n\nDetail text"
    );
  });

  it("throws a typed error when element_id is invalid", () => {
    expect(() => parseBitrixWebhook({ body: { element_id: "nope" } })).toThrow(
      BitrixWebhookParseError
    );
  });
});
