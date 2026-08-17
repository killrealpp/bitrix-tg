import { createHash } from "node:crypto";

// Bitrix sends both the admin edit link (`url`) and the public detail page
// (`public_url`). Only the public one may reach a published post, so the public
// aliases are tried first and anything pointing into the control panel is
// rejected outright.
const PRIVATE_URL_PATTERN = /\/bitrix\/(?:admin|tools)\//i;

// Bitrix returns DETAIL_PAGE_URL as a raw template when the macros are not
// resolved, e.g. `/#SITE_DIR#company/news/#SECTION_CODE#/#ELEMENT_CODE#/`.
// Such a link is broken for readers, so it is treated as no link at all.
const UNRESOLVED_MACRO_PATTERN = /#[A-Z_]+#/;

const PUBLIC_URL_PATHS = [
  "public_url",
  "PUBLIC_URL",
  "publicUrl",
  "fields.PUBLIC_URL",
  "detail_page_url",
  "DETAIL_PAGE_URL",
  "fields.DETAIL_PAGE_URL",
  "FIELDS.DETAIL_PAGE_URL",
  "url",
  "URL"
];

export interface NormalizedPhoto {
  id?: string;
  url?: string;
  path?: string;
  unresolved?: boolean;
  unresolvedReason?: "bitrix_file_id_without_url";
}

export type SocialValue = string | string[];
export type ScheduledAtPrecision = "date" | "datetime";
export type PublishTarget = "telegram" | "vk" | "max";
export type PostType =
  | "event"
  | "promo"
  | "company_news"
  | "product_new"
  | "entertainment"
  | "unknown";

export interface PublishTargets {
  telegram: boolean;
  vk: boolean;
  max: boolean;
}

export interface PropertyMetaEntry {
  id?: string;
  code: string;
  name?: string;
  value?: unknown;
}

export interface ParsedBitrixEvent {
  bitrixId: number;
  action: string;
  isActive: boolean;
  activeRaw: string;
  socialValue: SocialValue;
  publishSocial: boolean;
  publishTargets: PublishTargets;
  postType: PostType;
  postTypeRaw: string;
  propertyMeta: PropertyMetaEntry[];
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
  activeFromUtcOffsetMinutes?: number;
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
      "publish_social",
      "PUBLISH_SOCIAL",
      "pub_news_social",
      "PUB_NEWS_SOCIAL",
      "properties.publish_social",
      "properties.PUBLISH_SOCIAL",
      "properties.pub_news_social",
      "properties.PUB_NEWS_SOCIAL",
      "all_properties.publish_social",
      "all_properties.PUBLISH_SOCIAL",
      "all_properties.pub_news_social",
      "all_properties.PUB_NEWS_SOCIAL"
    ]) ?? allProperties.pub_news_social
  );
  const publishSocial = !isCheckboxValueFalseOrEmpty(socialValue);
  const publishTargets = publishSocial
    ? normalizePublishTargets(body)
    : defaultPublishTargets(false);
  const postTypeInfo = normalizePostType(
    readFirstValue(body, [
      "post_type",
      "POST_TYPE",
      "social_post_type",
      "SOCIAL_POST_TYPE",
      "content_type",
      "CONTENT_TYPE",
      "properties.post_type",
      "properties.POST_TYPE",
      "properties.social_post_type",
      "properties.SOCIAL_POST_TYPE",
      "all_properties.post_type",
      "all_properties.POST_TYPE",
      "all_properties.social_post_type",
      "all_properties.SOCIAL_POST_TYPE",
      "all_properties.TYPE",
      "all_properties.type",
      "section_name",
      "SECTION_NAME",
      "iblock_section_name",
      "IBLOCK_SECTION_NAME"
    ])
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
  const scheduledAt = parseScheduledAt(body, options);
  const activeRaw = toStringValue(readFirstValue(body, ["active", "ACTIVE"]))
    .trim()
    .toUpperCase();

  const eventWithoutHash = {
    bitrixId,
    action: toStringValue(readFirstValue(body, ["action", "ACTION"])),
    isActive: activeRaw === "Y",
    activeRaw,
    socialValue,
    publishSocial,
    publishTargets,
    postType: postTypeInfo.postType,
    postTypeRaw: postTypeInfo.raw,
    propertyMeta: normalizePropertyMeta(readFirstValue(body, [
      "property_meta",
      "PROPERTY_META",
      "properties_meta",
      "PROPERTIES_META"
    ])),
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
    url: pickPublicUrl(body),
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
      publishSocial: eventWithoutHash.publishSocial,
      publishTargets: eventWithoutHash.publishTargets,
      postType: eventWithoutHash.postType,
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

function normalizePublishTargets(body: Record<string, unknown>): PublishTargets {
  const explicitTargets = readFirstValue(body, [
    "publish_targets",
    "PUBLISH_TARGETS",
    "targets",
    "TARGETS",
    "social_targets",
    "SOCIAL_TARGETS"
  ]);

  if (isRecord(explicitTargets)) {
    return {
      telegram: checkboxValueToBoolean(
        readFirstValue(explicitTargets, ["telegram", "TELEGRAM", "tg", "TG"]),
        false
      ),
      vk: false,
      max: checkboxValueToBoolean(
        readFirstValue(explicitTargets, ["max", "MAX"]),
        false
      )
    };
  }

  const telegram = readFirstValue(body, [
    "publish_telegram",
    "PUBLISH_TELEGRAM",
    "telegram_publish",
    "TELEGRAM_PUBLISH",
    "pub_news_telegram",
    "PUB_NEWS_TELEGRAM",
    "pub_news_tg",
    "PUB_NEWS_TG",
    "publish_to_telegram",
    "PUBLISH_TO_TELEGRAM",
    "all_properties.publish_telegram",
    "all_properties.PUBLISH_TELEGRAM",
    "all_properties.telegram_publish",
    "all_properties.TELEGRAM_PUBLISH",
    "all_properties.pub_news_telegram",
    "all_properties.PUB_NEWS_TELEGRAM",
    "all_properties.pub_news_tg",
    "all_properties.PUB_NEWS_TG",
    "properties.publish_telegram",
    "properties.PUBLISH_TELEGRAM",
    "properties.pub_news_telegram",
    "properties.PUB_NEWS_TELEGRAM",
    "properties.pub_news_tg",
    "properties.PUB_NEWS_TG"
  ]);
  const vk = readFirstValue(body, [
    "publish_vk",
    "PUBLISH_VK",
    "vk_publish",
    "VK_PUBLISH",
    "pub_news_vk",
    "PUB_NEWS_VK",
    "pub_news_vkpost",
    "PUB_NEWS_VKPOST",
    "publish_to_vk",
    "PUBLISH_TO_VK",
    "publish_vkontakte",
    "PUBLISH_VKONTAKTE",
    "all_properties.publish_vk",
    "all_properties.PUBLISH_VK",
    "all_properties.vk_publish",
    "all_properties.VK_PUBLISH",
    "all_properties.pub_news_vk",
    "all_properties.PUB_NEWS_VK",
    "all_properties.pub_news_vkpost",
    "all_properties.PUB_NEWS_VKPOST",
    "all_properties.publish_vkontakte",
    "all_properties.PUBLISH_VKONTAKTE",
    "properties.publish_vk",
    "properties.PUBLISH_VK",
    "properties.pub_news_vk",
    "properties.PUB_NEWS_VK",
    "properties.pub_news_vkpost",
    "properties.PUB_NEWS_VKPOST"
  ]);
  const max = readFirstValue(body, [
    "publish_max",
    "PUBLISH_MAX",
    "max_publish",
    "MAX_PUBLISH",
    "pub_news_max",
    "PUB_NEWS_MAX",
    "publish_to_max",
    "PUBLISH_TO_MAX",
    "all_properties.publish_max",
    "all_properties.PUBLISH_MAX",
    "all_properties.max_publish",
    "all_properties.MAX_PUBLISH",
    "all_properties.pub_news_max",
    "all_properties.PUB_NEWS_MAX",
    "properties.publish_max",
    "properties.PUBLISH_MAX",
    "properties.pub_news_max",
    "properties.PUB_NEWS_MAX"
  ]);

  return {
    telegram: checkboxValueToBoolean(telegram, true),
    vk: false,
    max: checkboxValueToBoolean(max, false)
  };
}

function defaultPublishTargets(value: boolean): PublishTargets {
  return {
    telegram: value,
    vk: false,
    max: value
  };
}

function checkboxValueToBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (Array.isArray(value)) {
    return value.some((item) => checkboxValueToBoolean(item, false));
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const text = toStringValue(value).trim();
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  if (["n", "no", "нет", "false", "0", "off", "unchecked"].includes(normalized)) {
    return false;
  }

  return true;
}

function isCheckboxValueFalseOrEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0 || !value.some((item) => checkboxValueToBoolean(item, false));
  }

  return !checkboxValueToBoolean(value, false);
}

function normalizePostType(value: unknown): {
  postType: PostType;
  raw: string;
} {
  const raw = Array.isArray(value)
    ? value.map((item) => toStringValue(item)).find((item) => item.trim()) ?? ""
    : toStringValue(value);
  const normalized = raw.trim().toLowerCase();

  if (!normalized) {
    return { postType: "unknown", raw: "" };
  }

  if (/(^|\s|_|-)(event|events|событи|мероприят)/i.test(normalized)) {
    return { postType: "event", raw };
  }

  if (/(^|\s|_|-)(promo|promotion|sale|discount|акци|скидк|распрод)/i.test(normalized)) {
    return { postType: "promo", raw };
  }

  if (/(новинк|new[_\s-]?product|product[_\s-]?new|новый\s+товар)/i.test(normalized)) {
    return { postType: "product_new", raw };
  }

  if (
    /company[_\s-]?news|новост[ьи]\s+компан|новост[ьи]\s+магазин|корпоративн|news|новост/i.test(
      normalized
    )
  ) {
    return { postType: "company_news", raw };
  }

  if (/(entertainment|fun|развлекатель|юмор|полезн)/i.test(normalized)) {
    return { postType: "entertainment", raw };
  }

  return { postType: "unknown", raw };
}

function normalizePropertyMeta(value: unknown): PropertyMetaEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const code = toStringValue(item.code ?? item.CODE).trim();
    if (!code) {
      return [];
    }

    return [
      {
        id: optionalString(item.id ?? item.ID),
        code,
        name: optionalString(item.name ?? item.NAME),
        value: item.value ?? item.VALUE
      }
    ];
  });
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
  options: ParseBitrixWebhookOptions
): {
  date: Date | null;
  sourceField: string | null;
  rawValue: string | null;
  precision: ScheduledAtPrecision | null;
} {
  const candidateFields = uniqueStrings([
    options.activeFromField,
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

    const parsed = parseDateValue(value, options.activeFromUtcOffsetMinutes);
    if (parsed) {
      return {
        date: parsed.date,
        sourceField: field,
        rawValue: toStringValue(value),
        precision: parsed.precision
      };
    }

    return {
      date: null,
      sourceField: field,
      rawValue: toStringValue(value),
      precision: null
    };
  }

  return {
    date: null,
    sourceField: null,
    rawValue: null,
    precision: null
  };
}

function parseDateValue(
  value: unknown,
  utcOffsetMinutes?: number
): {
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

  const bitrixDate = parseBitrixDate(text, utcOffsetMinutes);
  if (bitrixDate) {
    return bitrixDate;
  }

  if (utcOffsetMinutes !== undefined && !hasExplicitTimezone(text)) {
    const localIsoDate = parseIsoLikeLocalDate(text);
    if (localIsoDate) {
      return {
        date: localPartsToDate(localIsoDate, utcOffsetMinutes),
        precision: hasExplicitTime(text) ? "datetime" : "date"
      };
    }
  }

  const precision = hasExplicitTime(text) ? "datetime" : "date";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(" ", "T")
    : text;
  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : { date, precision };
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseBitrixDate(
  text: string,
  utcOffsetMinutes?: number
): {
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
  const parts = { year, month, day, hour, minute, second };
  const date =
    utcOffsetMinutes === undefined
      ? new Date(year, month - 1, day, hour, minute, second)
      : localPartsToDate(parts, utcOffsetMinutes);
  const validationDate = new Date(year, month - 1, day, hour, minute, second);

  if (
    validationDate.getFullYear() !== year ||
    validationDate.getMonth() !== month - 1 ||
    validationDate.getDate() !== day ||
    validationDate.getHours() !== hour ||
    validationDate.getMinutes() !== minute ||
    validationDate.getSeconds() !== second
  ) {
    return null;
  }

  return {
    date,
    precision: hourText && minuteText ? "datetime" : "date"
  };
}

function parseIsoLikeLocalDate(text: string): LocalDateParts | null {
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const parts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText ?? 0),
    minute: Number(minuteText ?? 0),
    second: Number(secondText ?? 0)
  };
  const validationDate = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  if (
    validationDate.getFullYear() !== parts.year ||
    validationDate.getMonth() !== parts.month - 1 ||
    validationDate.getDate() !== parts.day ||
    validationDate.getHours() !== parts.hour ||
    validationDate.getMinutes() !== parts.minute ||
    validationDate.getSeconds() !== parts.second
  ) {
    return null;
  }

  return parts;
}

function localPartsToDate(
  parts: LocalDateParts,
  utcOffsetMinutes: number
): Date {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) -
      utcOffsetMinutes * 60 * 1000
  );
}

function hasExplicitTimezone(text: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
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

function pickPublicUrl(body: Record<string, unknown>): string {
  for (const path of PUBLIC_URL_PATHS) {
    const value = toStringValue(readFirstValue(body, [path])).trim();
    if (
      !value ||
      PRIVATE_URL_PATTERN.test(value) ||
      UNRESOLVED_MACRO_PATTERN.test(value)
    ) {
      continue;
    }

    return value;
  }

  return "";
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
