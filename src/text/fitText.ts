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

export interface TextFitOptions {
  aiFit?: (request: TextFitRequest) => Promise<string>;
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
    const fitted = (await options.aiFit({ text: normalized, limit, target, kind })).trim();
    if (fitted.length <= limit) {
      return fitted;
    }
  }

  return truncateAtWord(normalized, target);
}

function truncateAtWord(text: string, target: number): string {
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
