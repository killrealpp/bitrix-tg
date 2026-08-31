import type { SocialTextPlatform } from "./socialPlatforms";

const OWN_FOLLOW_LINK: Record<SocialTextPlatform, string> = {
  telegram: "https://t.me/svarnoymagazin",
  max: "https://max.ru/id4025424601_biz"
};

const EVENT_DIALOG_LINK: Record<SocialTextPlatform, string> = {
  telegram: "https://t.me/MagazinSvarnoy",
  max: "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs"
};

/**
 * A reader is already in the channel where the post is displayed, so the
 * matching link must not be repeated in the "Следите за нами" footer.
 */
export function removeOwnPlatformFollowLink(
  text: string,
  platform: SocialTextPlatform
): string {
  const ownLink = OWN_FOLLOW_LINK[platform];
  let removed = false;
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => {
    const isOwnFollowLine =
      line.includes(ownLink) && /^\s*(?:—\s*)?(?:telegram|max)\s*:/iu.test(line);

    removed ||= isOwnFollowLine;
    return !isOwnFollowLine;
  });

  return removed ? lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}

/** Removes a literal backslash placed before a real line break by an AI response. */
export function sanitizeSocialPostText(
  text: string,
  platform: SocialTextPlatform
): string {
  return removeOwnPlatformFollowLink(text.replace(/\\\r?\n/g, "\n"), platform);
}

export function buildEventFooter(platform: SocialTextPlatform): string {
  const followLinks =
    platform === "telegram"
      ? [
          "— MAX: https://max.ru/id4025424601_biz",
          "— ВК: https://vk.com/svarnoy40"
        ]
      : [
          "— Telegram: https://t.me/svarnoymagazin",
          "— ВК: https://vk.com/svarnoy40"
        ];

  return [
    "💬 Если остались вопросы по событию, мы на связи. Будем рады ответить на ваши вопросы:",
    EVENT_DIALOG_LINK[platform],
    "",
    "📌 Следите за нами:",
    ...followLinks
  ].join("\n");
}

export function removeEventFooter(text: string): string {
  const footerMarkers = [
    "👉 Для заказа",
    "💬 Если остались вопросы по событию",
    "📌 Следите за нами:"
  ];
  const start = footerMarkers.reduce<number | null>((first, marker) => {
    const index = text.indexOf(marker);
    return index >= 0 && (first === null || index < first) ? index : first;
  }, null);

  return (start === null ? text : text.slice(0, start)).trim();
}
