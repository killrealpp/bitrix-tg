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
  const photos = readFirstPhotos(body, [
    "all_properties.PHOTOS",
    "all_properties.photos",
    "all_properties.PHOTO",
    "all_properties.photo",
    "all_properties.MORE_PHOTO",
    "all_properties.more_photo",
    "properties.PHOTOS",
    "properties.photos",
    "properties.PHOTO",
    "properties.photo",
    "properties.MORE_PHOTO",
    "properties.more_photo",
    "fields.PHOTOS",
    "fields.photos",
    "fields.PHOTO",
    "fields.photo",
    "PHOTOS",
    "photos",
    "PHOTO",
    "photo",
    "preview_picture",
    "PREVIEW_PICTURE",
    "detail_picture",
    "DETAIL_PICTURE",
    "fields.PREVIEW_PICTURE",
    "fields.DETAIL_PICTURE"
  ]);
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

  return normalizePhotoValue(value);
}

function normalizePhotoValue(value: unknown): NormalizedPhoto[] {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(normalizePhotoValue);
  }

  if (typeof value === "string") {
    const text = value.trim();
    const parsedJson = parseMaybeJsonPhotoValue(text);
    if (parsedJson !== undefined) {
      return normalizePhotoValue(parsedJson);
    }

    if (isCommaSeparatedPhotoList(text)) {
      return text
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .flatMap(normalizePhotoValue);
    }

    if (isHttpUrl(text)) {
      return [{ url: text }];
    }

    return unresolvedPhotoId(text);
  }

  if (typeof value === "number") {
    return unresolvedPhotoId(String(value));
  }

  if (!isRecord(value)) {
    return [];
  }

  const direct = normalizePhotoRecord(value);
  if (direct.length > 0) {
    return direct;
  }

  const nested = normalizeNestedPhotoFields(value);
  if (nested.length > 0) {
    return nested;
  }

  if (isCollectionRecord(value) || isPhotoValueCollection(value)) {
    return Object.values(value).flatMap(normalizePhotoValue);
  }

  return [];
}

function normalizePhotoRecord(record: Record<string, unknown>): NormalizedPhoto[] {
  const url = readOptionalString(record, [
    "url",
    "URL",
    "src",
    "SRC",
    "download_url",
    "DOWNLOAD_URL",
    "downloadUrl",
    "file_url",
    "FILE_URL",
    "fileUrl"
  ]);
  const id = readOptionalScalarString(record, [
    "id",
    "ID",
    "file_id",
    "FILE_ID",
    "fileId",
    "VALUE",
    "value"
  ]);
  const path = readOptionalString(record, [
    "path",
    "PATH",
    "file_path",
    "FILE_PATH",
    "filePath"
  ]);

  if (url) {
    return [
      {
        id,
        url,
        path
      }
    ];
  }

  if (id) {
    return [
      {
        id,
        path,
        unresolved: true,
        unresolvedReason: "bitrix_file_id_without_url"
      }
    ];
  }

  return [];
}

function normalizeNestedPhotoFields(record: Record<string, unknown>): NormalizedPhoto[] {
  const nestedFields = [
    "VALUE",
    "value",
    "VALUES",
    "values",
    "FILE",
    "file",
    "PHOTO",
    "photo",
    "PHOTOS",
    "photos",
    "ITEMS",
    "items"
  ];

  for (const field of nestedFields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      continue;
    }

    const photos = normalizePhotoValue(record[field]);
    if (photos.length > 0) {
      return photos;
    }
  }

  return [];
}

function unresolvedPhotoId(id: string): NormalizedPhoto[] {
  const trimmed = id.trim();
  return trimmed
    ? [
        {
          id: trimmed,
          unresolved: true,
          unresolvedReason: "bitrix_file_id_without_url"
        }
      ]
    : [];
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

function readFirstPhotos(
  body: Record<string, unknown>,
  paths: string[]
): NormalizedPhoto[] {
  for (const path of paths) {
    const value = readByPath(body, path);
    const photos = normalizePhotos(value);
    if (photos.length > 0) {
      return photos;
    }
  }

  return [];
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

function readOptionalString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) {
      continue;
    }

    const text = toStringValue(value).trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

function readOptionalScalarString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined || isRecord(value) || Array.isArray(value)) {
      continue;
    }

    const text = toStringValue(value).trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

function parseMaybeJsonPhotoValue(text: string): unknown | undefined {
  if (!text.startsWith("[") && !text.startsWith("{")) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isCommaSeparatedPhotoList(text: string): boolean {
  return (
    text.includes(",") &&
    text
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .every((entry) => /^\d+$/.test(entry) || isHttpUrl(entry))
  );
}

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function isCollectionRecord(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    keys.length > 0 &&
    keys.every((key) => /^\d+$/.test(key) || /^n\d+$/i.test(key))
  );
}

function isPhotoValueCollection(record: Record<string, unknown>): boolean {
  const values = Object.values(record);
  return values.length > 0 && values.every(isLikelyPhotoValue);
}

function isLikelyPhotoValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number") {
    return true;
  }

  if (Array.isArray(value)) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  return [
    "url",
    "URL",
    "src",
    "SRC",
    "id",
    "ID",
    "file_id",
    "FILE_ID",
    "VALUE",
    "value",
    "path",
    "PATH"
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
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
