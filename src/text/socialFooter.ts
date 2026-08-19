import type { SocialTextPlatform } from "./socialPlatforms";

const OWN_FOLLOW_LINK: Record<SocialTextPlatform, string> = {
  telegram: "https://t.me/svarnoymagazin",
  max: "https://max.ru/id4025424601_biz"
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
