import { describe, expect, it } from "vitest";
import type { PostType } from "../src/bitrix/parseWebhook";
import { parseBitrixWebhook } from "../src/bitrix/parseWebhook";
import { prepareSocialText } from "../src/text/socialText";

describe("prepareSocialText", () => {
  it.each([
    ["event", "event"],
    ["promo", "promo"],
    ["company news", "company_news"],
    ["entertainment", "entertainment"],
    ["unknown", "unknown"]
  ] satisfies Array<[string, PostType]>)(
    "calls AI preparation for %s posts",
    async (_label, postType) => {
      const calls: unknown[] = [];
      const text = await prepareSocialText(eventWithPostType(postType), "Source text", {
        aiPrepare: async (request) => {
          calls.push(request);
          return `AI ${postType} post`;
        }
      });

      expect(text).toBe(`AI ${postType} post`);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        bitrixId: 1,
        postType,
        target: 1000
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
      const text = await prepareSocialText(eventWithPostType(postType), "Line 1\n\nLine 2", {
        aiPrepare: async (request) => {
          calls.push(request);
          throw new Error("AI unavailable");
        }
      });

      expect(calls).toHaveLength(1);
      expect(text).toBe("✨ Line 1\n\nLine 2");
    }
  );

  it("truncates overlong AI output instead of blocking publication", async () => {
    const text = await prepareSocialText(eventWithPostType("promo"), "Source text", {
      aiPrepare: async () => "word ".repeat(400)
    });

    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/^word/);
  });

  it("falls back to deterministic formatting when AI throws", async () => {
    const text = await prepareSocialText(eventWithPostType("company_news"), "News", {
      aiPrepare: async () => {
        throw new Error("provider is down");
      }
    });

    expect(text).toBe("📢 News");
  });

  it("reports AI preparation failures before deterministic fallback", async () => {
    const failures: unknown[] = [];
    const text = await prepareSocialText(eventWithPostType("company_news"), "News", {
      aiPrepare: async () => {
        throw new Error("provider is down");
      },
      onAiPrepareFailure: async (failure) => {
        failures.push(failure);
      }
    });

    expect(text).toBe("📢 News");
    expect(failures).toEqual([
      {
        bitrixId: 1,
        postType: "company_news",
        error: "provider is down"
      }
    ]);
  });

  it("reports empty AI preparation before deterministic fallback", async () => {
    const failures: unknown[] = [];
    const text = await prepareSocialText(eventWithPostType("promo"), "Sale", {
      aiPrepare: async () => "   ",
      onAiPrepareFailure: async (failure) => {
        failures.push(failure);
      }
    });

    expect(text).toBe("🔥 Sale");
    expect(failures).toEqual([
      {
        bitrixId: 1,
        postType: "promo",
        error: "AI social text preparation returned an empty response"
      }
    ]);
  });
});

function eventWithPostType(postType: PostType) {
  const [event] = parseBitrixWebhook({
    body: {
      element_id: 1,
      active: "Y",
      publish_social: "Y",
      publish_targets: {
        telegram: "Y"
      },
      post_type: postType,
      name: "Title"
    }
  });

  return {
    ...event,
    postType
  };
}
