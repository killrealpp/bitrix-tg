import { describe, expect, it } from "vitest";
import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_CAPTION_TARGET,
  fitForTelegramCaption,
  fitForTelegramText
} from "../src/text/fitText";

describe("text fitting", () => {
  it("returns short text unchanged", async () => {
    const calls: string[] = [];

    await expect(
      fitForTelegramText("Short text", {
        aiFit: async () => {
          calls.push("ai");
          return "AI text";
        }
      })
    ).resolves.toBe("Short text");

    expect(calls).toHaveLength(0);
  });

  it("uses AI fitting only when text exceeds the limit", async () => {
    const longText = "word ".repeat(900);
    const fitted = await fitForTelegramCaption(longText, {
      aiFit: async () => "Short caption"
    });

    expect(fitted).toBe("Short caption");
  });

  it("falls back to deterministic truncation if AI output is still too long", async () => {
    const longText = "word ".repeat(900);
    const fitted = await fitForTelegramCaption(longText, {
      aiFit: async () => longText
    });

    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(fitted.endsWith("...")).toBe(true);
  });

  it("falls back to deterministic truncation if AI fitting fails", async () => {
    const longText = "word ".repeat(900);
    const fitted = await fitForTelegramCaption(longText, {
      aiFit: async () => {
        throw new Error("AI unavailable");
      }
    });

    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_TARGET);
    expect(fitted.endsWith("...")).toBe(true);
  });

  it("falls back to deterministic truncation if AI returns empty text", async () => {
    const longText = "word ".repeat(900);
    const fitted = await fitForTelegramCaption(longText, {
      aiFit: async () => "   "
    });

    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_TARGET);
    expect(fitted.endsWith("...")).toBe(true);
  });
});
