import { describe, expect, it } from "vitest";
import type { PostType } from "../src/bitrix/parseWebhook";
import { parseBitrixWebhook } from "../src/bitrix/parseWebhook";
import { prepareSocialText } from "../src/text/socialText";

describe("prepareSocialText", () => {
  it.each([
    ["event", "event"],
    ["promo", "promo"],
    ["company news", "company_news"]
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
        postType,
        target: 1000
      });
    }
  );

  it.each([
    ["entertainment", "entertainment"],
    ["unknown", "unknown"]
  ] satisfies Array<[string, PostType]>)(
    "does not call AI preparation for %s posts",
    async (_label, postType) => {
      const calls: unknown[] = [];
      const text = await prepareSocialText(eventWithPostType(postType), "Line 1\n\nLine 2", {
        aiPrepare: async (request) => {
          calls.push(request);
          return "AI should not run";
        }
      });

      expect(calls).toHaveLength(0);
      expect(text).toBe(postType === "entertainment" ? "✨ Line 1\n\nLine 2" : "Line 1\n\nLine 2");
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
