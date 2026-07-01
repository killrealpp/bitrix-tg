import type { PostType } from "../bitrix/parseWebhook";

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
  text: string;
  postType: PostType;
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

  return truncateAtWord(normalized, target);
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
