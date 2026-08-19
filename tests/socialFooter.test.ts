import { describe, expect, it } from "vitest";
import {
  removeOwnPlatformFollowLink,
  sanitizeSocialPostText
} from "../src/text/socialFooter";

describe("removeOwnPlatformFollowLink", () => {
  const footer = [
    "📌 Следите за нами:",
    "— MAX: https://max.ru/id4025424601_biz",
    "— Telegram: https://t.me/svarnoymagazin",
    "— ВК: https://vk.com/svarnoy40"
  ].join("\n");

  it("removes the Telegram channel link from a Telegram post", () => {
    const text = removeOwnPlatformFollowLink(footer, "telegram");

    expect(text).not.toContain("https://t.me/svarnoymagazin");
    expect(text).toContain("https://max.ru/id4025424601_biz");
    expect(text).toContain("https://vk.com/svarnoy40");
  });

  it("removes the MAX channel link from a MAX post", () => {
    const text = removeOwnPlatformFollowLink(footer, "max");

    expect(text).not.toContain("https://max.ru/id4025424601_biz");
    expect(text).toContain("https://t.me/svarnoymagazin");
    expect(text).toContain("https://vk.com/svarnoy40");
  });

  it("removes a literal backslash before a line break", () => {
    expect(sanitizeSocialPostText("Почему стоит посетить? ✅\\\n— Новые технологии", "telegram")).toBe(
      "Почему стоит посетить? ✅\n— Новые технологии"
    );
  });
});
