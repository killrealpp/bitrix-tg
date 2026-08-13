import type { ParsedBitrixEvent, PostType } from "../bitrix/parseWebhook";
import {
  TELEGRAM_CAPTION_TARGET,
  truncateTelegramCaptionAtWord,
  truncateAtWord,
  type TextFitOptions
} from "./fitText";
import type { SocialTextPlatform } from "./socialPlatforms";

export const SOCIAL_AI_TARGET = 1200;
export const TELEGRAM_SOCIAL_CAPTION_TARGET = TELEGRAM_CAPTION_TARGET;

export function shouldUseAiPrompt(_postType: PostType): boolean {
  return true;
}

export async function prepareSocialText(
  event: ParsedBitrixEvent,
  sourceText: string,
  platform: SocialTextPlatform,
  options: TextFitOptions = {}
): Promise<string> {
  const formatted = formatOnlyText(sourceText, event.postType);
  const publicationKind = getSocialPublicationKind(event, platform);
  const target = getSocialPrepareTarget(event, platform);

  if (!shouldUseAiPrompt(event.postType) || !options.aiPrepare) {
    return formatted;
  }

  try {
    const prepared = (
      await options.aiPrepare({
        bitrixId: event.bitrixId,
        text: formatted,
        postType: event.postType,
        platform,
        publicationKind,
        hasPhotos: event.photos.length > 0,
        target,
        title: event.title,
        previewText: event.previewText,
        detailText: event.detailText,
        scheduledAtRawValue: event.scheduledAtRawValue,
        url: event.url
      })
    ).trim();

    if (prepared.length > 0 && prepared.length <= target) {
      return prepared;
    }

    if (prepared.length > target) {
      return truncatePreparedSocialText(prepared, target, platform, publicationKind);
    }

    await notifyAiPrepareFailure(
      event,
      options,
      platform,
      new Error("AI social text preparation returned an empty response")
    );
  } catch (error) {
    await notifyAiPrepareFailure(event, options, platform, error);
    // Deterministic formatting keeps publication available if AI is unavailable.
  }

  return truncatePreparedSocialText(formatted, target, platform, publicationKind);
}

function truncatePreparedSocialText(
  text: string,
  target: number,
  platform: SocialTextPlatform,
  publicationKind: "text" | "caption"
): string {
  return platform === "telegram" && publicationKind === "caption"
    ? truncateTelegramCaptionAtWord(text, target)
    : truncateAtWord(text, target);
}

function getSocialPublicationKind(
  event: ParsedBitrixEvent,
  platform: SocialTextPlatform
): "text" | "caption" {
  return platform === "telegram" && event.photos.length > 0 ? "caption" : "text";
}

function getSocialPrepareTarget(
  event: ParsedBitrixEvent,
  platform: SocialTextPlatform
): number {
  return platform === "telegram" && event.photos.length > 0
    ? TELEGRAM_SOCIAL_CAPTION_TARGET
    : SOCIAL_AI_TARGET;
}

async function notifyAiPrepareFailure(
  event: ParsedBitrixEvent,
  options: TextFitOptions,
  platform: SocialTextPlatform,
  error: unknown
): Promise<void> {
  if (!options.onAiPrepareFailure) {
    return;
  }

  try {
    await options.onAiPrepareFailure({
      bitrixId: event.bitrixId,
      postType: event.postType,
      platform,
      error: error instanceof Error ? error.message : String(error)
    });
  } catch {
    // AI failure logging must not block deterministic publication fallback.
  }
}

export function formatOnlyText(text: string, postType: PostType): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!normalized) {
    return "";
  }

  const marker = markerForPostType(postType);
  if (!marker) {
    return normalized;
  }

  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(normalized)) {
    return normalized;
  }

  return `${marker} ${normalized}`;
}

function markerForPostType(postType: PostType): string {
  switch (postType) {
    case "event":
      return "📅";
    case "promo":
      return "🔥";
    case "company_news":
      return "📢";
    case "product_new":
      return "🆕";
    case "entertainment":
      return "✨";
    default:
      return "✨";
  }
}
