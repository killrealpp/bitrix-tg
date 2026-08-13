import type { PostType } from "../bitrix/parseWebhook";
import type { SocialTextPlatform } from "./socialPlatforms";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_TEXT_TARGET = 3900;
export const TELEGRAM_CAPTION_TARGET = 950;

export interface TextFitRequest {
  text: string;
  limit: number;
  target: number;
  kind: "text" | "caption";
}

export interface SocialTextPrepareRequest {
  bitrixId: number;
  text: string;
  postType: PostType;
  platform: SocialTextPlatform;
  publicationKind: "text" | "caption";
  hasPhotos: boolean;
  target: number;
  title: string;
  previewText: string;
  detailText: string;
  scheduledAtRawValue: string | null;
  url: string;
}

export interface TextFitOptions {
  aiFit?: (request: TextFitRequest) => Promise<string>;
  aiPrepare?: (request: SocialTextPrepareRequest) => Promise<string>;
  onAiPrepareFailure?: (failure: {
    bitrixId: number;
    postType: PostType;
    platform: SocialTextPlatform;
    error: string;
  }) => void | Promise<void>;
}

export async function fitForTelegramText(
  text: string,
  options: TextFitOptions = {}
): Promise<string> {
  return fitText(text, TELEGRAM_TEXT_LIMIT, TELEGRAM_TEXT_TARGET, "text", options);
}

export async function fitForTelegramCaption(
  text: string,
  options: TextFitOptions = {}
): Promise<string> {
  return fitText(
    text,
    TELEGRAM_CAPTION_LIMIT,
    TELEGRAM_CAPTION_TARGET,
    "caption",
    options
  );
}

export async function fitForMaxText(text: string): Promise<string> {
  return fitText(text, 4000, 3800, "text", {});
}

export async function fitForVkPost(text: string): Promise<string> {
  return fitText(text, 16_000, 15_500, "text", {});
}

async function fitText(
  text: string,
  limit: number,
  target: number,
  kind: "text" | "caption",
  options: TextFitOptions
): Promise<string> {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  if (options.aiFit) {
    try {
      const fitted = (
        await options.aiFit({ text: normalized, limit, target, kind })
      ).trim();
      if (fitted.length > 0 && fitted.length <= limit) {
        return fitted;
      }
    } catch {
      // Deterministic truncation below keeps publishing available if AI fails.
    }
  }

  return kind === "caption"
    ? truncateTelegramCaptionAtWord(normalized, target)
    : truncateAtWord(normalized, target);
}

export function truncateTelegramCaptionAtWord(text: string, target: number): string {
  if (text.length <= target) {
    return text;
  }

  const tailStart = findSocialTailStart(text);
  if (tailStart <= 0) {
    return truncateAtWord(text, target);
  }

  const prefix = text.slice(0, tailStart).trim();
  const tail = text.slice(tailStart).trim();
  const separator = "\n\n";
  const prefixTarget = target - tail.length - separator.length;

  if (prefixTarget <= 20) {
    return truncateAtWord(text, target);
  }

  const truncatedPrefix = truncateAtWord(prefix, prefixTarget);
  return `${truncatedPrefix}${separator}${tail}`;
}

export function truncateAtWord(text: string, target: number): string {
  if (text.length <= target) {
    return text;
  }

  if (target <= 3) {
    return "...".slice(0, target);
  }

  const slice = text.slice(0, target - 3);
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  );

  if (lastSentence > target * 0.6) {
    return `${slice.slice(0, lastSentence + 1).trim()}...`;
  }

  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > target * 0.6) {
    return `${slice.slice(0, lastSpace).trim()}...`;
  }

  return `${slice.trim()}...`;
}

function findSocialTailStart(text: string): number {
  const followIndex = text.lastIndexOf("📌 Следите за нами:");
  const orderIndex = text.lastIndexOf("👉 Для заказа");

  if (orderIndex >= 0 && (followIndex < 0 || orderIndex < followIndex)) {
    return orderIndex;
  }

  return followIndex;
}
