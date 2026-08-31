import { describe, expect, it } from "vitest";
import type { PostType } from "../src/bitrix/parseWebhook";
import { parseBitrixWebhook } from "../src/bitrix/parseWebhook";
import {
  TELEGRAM_SOCIAL_CAPTION_TARGET,
  prepareSocialText
} from "../src/text/socialText";

describe("prepareSocialText", () => {
  it.each([
    ["event", "event"],
    ["promo", "promo"],
    ["company news", "company_news"],
    ["product new", "product_new"],
    ["entertainment", "entertainment"],
    ["unknown", "unknown"]
  ] satisfies Array<[string, PostType]>)(
    "calls AI preparation for %s posts",
    async (_label, postType) => {
      const calls: unknown[] = [];
      const text = await prepareSocialText(
        eventWithPostType(postType),
        "Source text",
        "telegram",
        {
          aiPrepare: async (request) => {
            calls.push(request);
            return `AI ${postType} post`;
          }
        }
      );

      if (postType === "event") {
        expect(text).toContain(`AI ${postType} post`);
      } else {
        expect(text).toBe(`AI ${postType} post`);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        bitrixId: 1,
        postType,
        platform: "telegram",
        publicationKind: "text",
        hasPhotos: false,
        target: 1200
      });
    }
  );

  it.each([
    ["entertainment", "entertainment"],
    ["unknown", "unknown"]
  ] satisfies Array<[string, PostType]>)(
    "falls back to light formatting for %s posts when AI is unavailable",
    async (_label, postType) => {
      const calls: unknown[] = [];
      const text = await prepareSocialText(
        eventWithPostType(postType),
        "Line 1\n\nLine 2",
        "telegram",
        {
          aiPrepare: async (request) => {
            calls.push(request);
            throw new Error("AI unavailable");
          }
        }
      );

      expect(calls).toHaveLength(1);
      expect(text).toBe("✨ Line 1\n\nLine 2");
    }
  );

  it("truncates overlong AI output instead of blocking publication", async () => {
    const text = await prepareSocialText(
      eventWithPostType("promo"),
      "Source text",
      "telegram",
      {
        aiPrepare: async () => "word ".repeat(400)
      }
    );

    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toMatch(/^word/);
  });

  it("uses the Telegram caption target only when the post has photos", async () => {
    const calls: unknown[] = [];
    const text = await prepareSocialText(
      eventWithPostType("company_news", true),
      "Source text",
      "telegram",
      {
        aiPrepare: async (request) => {
          calls.push(request);
          return "Caption-ready text";
        }
      }
    );

    expect(text).toBe("Caption-ready text");
    expect(calls).toEqual([
      expect.objectContaining({
        platform: "telegram",
        publicationKind: "caption",
        hasPhotos: true,
        target: TELEGRAM_SOCIAL_CAPTION_TARGET
      })
    ]);
  });

  it("keeps the normal SMM target for MAX even when the post has photos", async () => {
    const calls: unknown[] = [];
    const text = await prepareSocialText(
      eventWithPostType("company_news", true),
      "Source text",
      "max",
      {
        aiPrepare: async (request) => {
          calls.push(request);
          return "MAX text";
        }
      }
    );

    expect(text).toBe("MAX text");
    expect(calls).toEqual([
      expect.objectContaining({
        platform: "max",
        publicationKind: "text",
        hasPhotos: true,
        target: 1200
      })
    ]);
  });

  it.each([
    [
      "telegram",
      "https://t.me/MagazinSvarnoy",
      "— MAX: https://max.ru/id4025424601_biz"
    ],
    [
      "max",
      "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs",
      "— Telegram: https://t.me/svarnoymagazin"
    ]
  ] as const)(
    "always appends the required event contact and social links for %s",
    async (platform, dialogLink, socialLink) => {
      const text = await prepareSocialText(
        eventWithPostType("event"),
        "Weldex 2026",
        platform,
        {
          aiPrepare: async () =>
            [
              "📅 Weldex 2026",
              "Выставка пройдет в Москве с 6 по 9 октября.",
              "👉 Для заказа и бесплатной консультации: https://example.com/old",
              "📌 Следите за нами:",
              "— Telegram: https://t.me/svarnoymagazin"
            ].join("\n")
        }
      );

      expect(text).toContain("Если остались вопросы по событию, мы на связи.");
      expect(text).toContain(dialogLink);
      expect(text).toContain("📌 Следите за нами:");
      expect(text).toContain(socialLink);
      expect(text).toContain("— ВК: https://vk.com/svarnoy40");
      expect(text).not.toContain("Для заказа и бесплатной консультации");
    }
  );

  it("keeps the mandatory event footer when a Telegram photo caption is shortened", async () => {
    const text = await prepareSocialText(
      eventWithPostType("event", true),
      "Weldex 2026",
      "telegram",
      {
        aiPrepare: async () => "Подробности о мероприятии. ".repeat(200)
      }
    );

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_SOCIAL_CAPTION_TARGET);
    expect(text).toContain("Если остались вопросы по событию, мы на связи.");
    expect(text).toContain("https://t.me/MagazinSvarnoy");
    expect(text).toContain("— MAX: https://max.ru/id4025424601_biz");
    expect(text).toContain("— ВК: https://vk.com/svarnoy40");
  });

  it("preserves the required footer when overlong Telegram photo AI output is truncated", async () => {
    const footer = [
      "👉 Для заказа и бесплатной консультации: https://t.me/MagazinSvarnoy",
      "",
      "📌 Следите за нами:",
      "— MAX: https://max.ru/id4025424601_biz",
      "— ВК: https://vk.com/svarnoy40"
    ].join("\n");
    const text = await prepareSocialText(
      eventWithPostType("company_news", true),
      "News",
      "telegram",
      {
        aiPrepare: async () =>
          `${"Подробный технический текст о товаре и его применении. ".repeat(50)}\n\n${footer}`
      }
    );

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_SOCIAL_CAPTION_TARGET);
    expect(text).toContain("https://t.me/MagazinSvarnoy");
    expect(text).toContain("— MAX: https://max.ru/id4025424601_biz");
    expect(text).not.toContain("https://t.me/svarnoymagazin");
    expect(text).toContain("— ВК: https://vk.com/svarnoy40");
  });

  it("removes the MAX channel link from AI text prepared for MAX", async () => {
    const text = await prepareSocialText(
      eventWithPostType("company_news"),
      "News",
      "max",
      {
        aiPrepare: async () =>
          [
            "Новость",
            "",
            "📌 Следите за нами:",
            "— MAX: https://max.ru/id4025424601_biz",
            "— Telegram: https://t.me/svarnoymagazin",
            "— ВК: https://vk.com/svarnoy40"
          ].join("\n")
      }
    );

    expect(text).not.toContain("https://max.ru/id4025424601_biz");
    expect(text).toContain("https://t.me/svarnoymagazin");
    expect(text).toContain("https://vk.com/svarnoy40");
  });

  it("falls back to deterministic formatting when AI throws", async () => {
    const text = await prepareSocialText(
      eventWithPostType("company_news"),
      "News",
      "telegram",
      {
        aiPrepare: async () => {
          throw new Error("provider is down");
        }
      }
    );

    expect(text).toBe("📢 News");
  });

  it("reports AI preparation failures before deterministic fallback", async () => {
    const failures: unknown[] = [];
    const text = await prepareSocialText(
      eventWithPostType("company_news"),
      "News",
      "telegram",
      {
        aiPrepare: async () => {
          throw new Error("provider is down");
        },
        onAiPrepareFailure: async (failure) => {
          failures.push(failure);
        }
      }
    );

    expect(text).toBe("📢 News");
    expect(failures).toEqual([
      {
        bitrixId: 1,
        postType: "company_news",
        platform: "telegram",
        error: "provider is down"
      }
    ]);
  });

  it("reports empty AI preparation before deterministic fallback", async () => {
    const failures: unknown[] = [];
    const text = await prepareSocialText(
      eventWithPostType("promo"),
      "Sale",
      "max",
      {
        aiPrepare: async () => "   ",
        onAiPrepareFailure: async (failure) => {
          failures.push(failure);
        }
      }
    );

    expect(text).toBe("🔥 Sale");
    expect(failures).toEqual([
      {
        bitrixId: 1,
        postType: "promo",
        platform: "max",
        error: "AI social text preparation returned an empty response"
      }
    ]);
  });
});

function eventWithPostType(postType: PostType, withPhotos = false) {
  const [event] = parseBitrixWebhook({
    body: {
      element_id: 1,
      active: "Y",
      publish_social: "Y",
      publish_targets: {
        telegram: "Y"
      },
      post_type: postType,
      name: "Title",
      all_properties: withPhotos
        ? {
            PHOTOS: {
              url: "https://example.com/photo.jpg"
            }
          }
        : undefined
    }
  });

  return {
    ...event,
    postType
  };
}
