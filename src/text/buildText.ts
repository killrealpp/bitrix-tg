import type { ParsedBitrixEvent } from "../bitrix/parseWebhook";

export function buildTelegramSourceText(event: ParsedBitrixEvent): string {
  const seen = new Set<string>();

  return [event.title, event.previewText, event.detailText]
    .map(normalizeBitrixText)
    .filter((part) => {
      if (part.length === 0 || seen.has(part)) {
        return false;
      }

      seen.add(part);
      return true;
    })
    .join("\n\n")
    .trim();
}

export function normalizeBitrixText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      fromCodePoint(Number.parseInt(code, 10))
    );
}

function fromCodePoint(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}
