import { describe, expect, it } from "vitest";
import {
  TELEGRAM_CAPTION_LIMIT,
  fitForTelegramCaption,
  fitForTelegramText
} from "../src/text/fitText";

describe("text fitting", () => {
  it("returns short text unchanged", async () => {
    await expect(fitForTelegramText("Short text")).resolves.toBe("Short text");
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
});
