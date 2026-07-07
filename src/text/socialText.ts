import type { ParsedBitrixEvent, PostType } from "../bitrix/parseWebhook";
import { truncateAtWord, type TextFitOptions } from "./fitText";

export const SOCIAL_AI_TARGET = 1000;

export function shouldUseAiPrompt(_postType: PostType): boolean {
  return true;
}

export async function prepareSocialText(
  event: ParsedBitrixEvent,
  sourceText: string,
  options: TextFitOptions = {}
): Promise<string> {
  const formatted = formatOnlyText(sourceText, event.postType);

  if (!shouldUseAiPrompt(event.postType) || !options.aiPrepare) {
    return formatted;
  }

  try {
    const prepared = (
      await options.aiPrepare({
        bitrixId: event.bitrixId,
        text: formatted,
        postType: event.postType,
        target: SOCIAL_AI_TARGET,
        title: event.title,
        previewText: event.previewText,
        detailText: event.detailText,
        scheduledAtRawValue: event.scheduledAtRawValue,
        url: event.url
      })
    ).trim();

    if (prepared.length > 0 && prepared.length <= SOCIAL_AI_TARGET) {
      return prepared;
    }

    if (prepared.length > SOCIAL_AI_TARGET) {
      return truncateAtWord(prepared, SOCIAL_AI_TARGET);
    }

    await notifyAiPrepareFailure(
      event,
      options,
      new Error("AI social text preparation returned an empty response")
    );
  } catch (error) {
    await notifyAiPrepareFailure(event, options, error);
    // Deterministic formatting keeps publication available if AI is unavailable.
  }

  return truncateAtWord(formatted, SOCIAL_AI_TARGET);
}

async function notifyAiPrepareFailure(
  event: ParsedBitrixEvent,
  options: TextFitOptions,
  error: unknown
): Promise<void> {
  if (!options.onAiPrepareFailure) {
    return;
  }

  try {
    await options.onAiPrepareFailure({
      bitrixId: event.bitrixId,
      postType: event.postType,
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
    case "entertainment":
      return "✨";
    default:
      return "✨";
  }
}
