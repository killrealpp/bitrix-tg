import { createHash } from "node:crypto";

export interface NormalizedPhoto {
  id?: string;
  url?: string;
  path?: string;
  unresolved?: boolean;
  unresolvedReason?: "bitrix_file_id_without_url";
}

export type SocialValue = string | string[];
export type ScheduledAtPrecision = "date" | "datetime";

export interface ParsedBitrixEvent {
  bitrixId: number;
  action: string;
  isActive: boolean;
  activeRaw: string;
  socialValue: SocialValue;
  title: string;
  previewText: string;
  detailText: string;
  url: string;
  photos: NormalizedPhoto[];
  scheduledAt: Date | null;
  scheduledAtSourceField: string | null;
  scheduledAtRawValue: string | null;
  scheduledAtPrecision: ScheduledAtPrecision | null;
  payloadHash: string;
  rawBody: Record<string, unknown>;
}

export class BitrixWebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitrixWebhookParseError";
  }
}

export interface ParseBitrixWebhookOptions {
  activeFromField?: string;
}

export function parseBitrixWebhook(
  input: unknown,
  options: ParseBitrixWebhookOptions = {}
): ParsedBitrixEvent[] {
  const items = Array.isArray(input) ? input : [input];

  return items.map((item, index) => parseEnvelope(item, index, options));
}

export function isSocialValueEmpty(value: SocialValue): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return value.trim() === "";
}

function parseEnvelope(
  input: unknown,
  index: number,
  options: ParseBitrixWebhookOptions
): ParsedBitrixEvent {
  const body = extractBody(input, index);
  const bitrixId = normalizeBitrixId(body.element_id);
  const allProperties = isRecord(body.all_properties) ? body.all_properties : {};
  const socialValue = normalizeSocialValue(
    readFirstValue(body, [
      "pub_news_social",
      "PUB_NEWS_SOCIAL",
      "properties.pub_news_social",
      "properties.PUB_NEWS_SOCIAL",
      "all_properties.pub_news_social",
      "all_properties.PUB_NEWS_SOCIAL"
    ]) ?? allProperties.pub_news_social
  );
  const photos = normalizePhotos(
    readFirstValue(body, [
      "all_properties.PHOTOS",
      "all_properties.photos",
      "properties.PHOTOS",
      "properties.photos",
      "PHOTOS",
      "photos"
    ])
  );
  const scheduledAt = parseScheduledAt(body, options.activeFromField);
  const activeRaw = toStringValue(readFirstValue(body, ["active", "ACTIVE"]))
    .trim()
    .toUpperCase();

  const eventWithoutHash = {
    bitrixId,
    action: toStringValue(readFirstValue(body, ["action", "ACTION"])),
    isActive: activeRaw === "Y",
    activeRaw,
    socialValue,
    title: toStringValue(
      readFirstValue(body, ["name", "NAME", "fields.NAME", "FIELDS.NAME"])
    ),
    previewText: toStringValue(
      readFirstValue(body, [
        "preview_text",
        "PREVIEW_TEXT",
        "fields.PREVIEW_TEXT",
        "FIELDS.PREVIEW_TEXT"
      ])
    ),
    detailText: toStringValue(
      readFirstValue(body, [
        "detail_text",
        "DETAIL_TEXT",
        "fields.DETAIL_TEXT",
        "FIELDS.DETAIL_TEXT"
      ])
    ),
    url: toStringValue(
      readFirstValue(body, [
        "url",
        "URL",
        "detail_page_url",
        "DETAIL_PAGE_URL",
        "fields.DETAIL_PAGE_URL",
        "FIELDS.DETAIL_PAGE_URL"
      ])
    ),
    photos,
    scheduledAt: scheduledAt.date,
    scheduledAtSourceField: scheduledAt.sourceField,
    scheduledAtRawValue: scheduledAt.rawValue,
    scheduledAtPrecision: scheduledAt.precision,
    rawBody: body
  };

  return {
    ...eventWithoutHash,
    payloadHash: hashPayload({
      bitrixId: eventWithoutHash.bitrixId,
      activeRaw: eventWithoutHash.activeRaw,
      socialValue: eventWithoutHash.socialValue,
      title: eventWithoutHash.title,
      previewText: eventWithoutHash.previewText,
      detailText: eventWithoutHash.detailText,
      url: eventWithoutHash.url,
      photos: eventWithoutHash.photos,
      scheduledAt: eventWithoutHash.scheduledAt?.toISOString() ?? null,
      scheduledAtPrecision: eventWithoutHash.scheduledAtPrecision
    })
  };
}

function extractBody(input: unknown, index: number): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new BitrixWebhookParseError(`Webhook item ${index} must be an object`);
  }

  const candidate = isRecord(input.body) ? input.body : input;

  if (!isRecord(candidate)) {
    throw new BitrixWebhookParseError(`Webhook item ${index} has no body object`);
  }

  return candidate;
}

function normalizeBitrixId(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new BitrixWebhookParseError("element_id must be a positive integer");
  }

  return numberValue;
}

function normalizeSocialValue(value: unknown): SocialValue {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStringValue(item).trim())
      .filter((item) => item.length > 0);
  }

  return toStringValue(value).trim();
}

function normalizePhotos(value: unknown): NormalizedPhoto[] {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return [];
  }

  const rawPhotos = Array.isArray(value) ? value : [value];

  return rawPhotos.flatMap((photo): NormalizedPhoto[] => {
    if (typeof photo === "string" || typeof photo === "number") {
      const id = toStringValue(photo).trim();
      return id
        ? [
            {
              id,
              unresolved: true,
              unresolvedReason: "bitrix_file_id_without_url"
            }
          ]
        : [];
    }

    if (!isRecord(photo)) {
      return [];
    }

    const url = toStringValue(photo.url).trim();
    if (url) {
      return [
        {
          id: optionalString(photo.id),
          url,
          path: optionalString(photo.path)
        }
      ];
    }

    const id = optionalString(photo.id);
    if (id) {
      return [
        {
          id,
          path: optionalString(photo.path),
          unresolved: true,
          unresolvedReason: "bitrix_file_id_without_url"
        }
      ];
    }

    return [];
  });
}

function parseScheduledAt(
  body: Record<string, unknown>,
  configuredField?: string
): {
  date: Date | null;
  sourceField: string | null;
  rawValue: string | null;
  precision: ScheduledAtPrecision | null;
} {
  const candidateFields = uniqueStrings([
    configuredField,
    "DATE_ACTIVE_FROM",
    "ACTIVE_FROM",
    "active_from",
    "date_active_from",
    "activeFrom",
    "scheduledAt"
  ].filter(Boolean) as string[]).flatMap((field) => [
    field,
    `fields.${field}`,
    `FIELDS.${field}`,
    `all_properties.${field}`,
    `properties.${field}`
  ]);

  for (const field of candidateFields) {
    const value = readByPath(body, field);
    if (value === undefined || value === null || value === "") {
      continue;
    }

    const parsed = parseDateValue(value);
    if (parsed) {
      return {
        date: parsed.date,
        sourceField: field,
        rawValue: toStringValue(value),
        precision: parsed.precision
      };
    }
  }

  return {
    date: null,
    sourceField: null,
    rawValue: null,
    precision: null
  };
}

function parseDateValue(value: unknown): {
  date: Date;
  precision: ScheduledAtPrecision;
} | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      date: value,
      precision: "datetime"
    };
  }

  const text = toStringValue(value).trim();
  if (!text) {
    return null;
  }

  const bitrixDate = parseBitrixDate(text);
  if (bitrixDate) {
    return bitrixDate;
  }

  const precision = hasExplicitTime(text) ? "datetime" : "date";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(" ", "T")
    : text;
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : { date, precision };
}

function parseBitrixDate(text: string): {
  date: Date;
  precision: ScheduledAtPrecision;
} | null {
  const match = text.match(
    /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) {
    return null;
  }

  const [, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const hour = Number(hourText ?? 0);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }

  return {
    date,
    precision: hourText && minuteText ? "datetime" : "date"
  };
}

function hasExplicitTime(text: string): boolean {
  return /(?:T|\s)\d{2}:\d{2}/.test(text);
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function optionalString(value: unknown): string | undefined {
  const text = toStringValue(value).trim();
  return text.length > 0 ? text : undefined;
}

function readFirstValue(
  body: Record<string, unknown>,
  paths: string[]
): unknown | undefined {
  for (const path of paths) {
    const value = readByPath(body, path);
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" && value.trim() === "") {
      continue;
    }

    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    return value;
  }

  return undefined;
}

function readByPath(
  body: Record<string, unknown>,
  fieldPath: string
): unknown | undefined {
  if (Object.prototype.hasOwnProperty.call(body, fieldPath)) {
    return body[fieldPath];
  }

  const segments = fieldPath.split(".");
  let current: unknown = body;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
