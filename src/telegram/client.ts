import type { NormalizedPhoto } from "../bitrix/parseWebhook";
import { redactSensitiveText } from "../security/redaction";

export type TelegramMessageRole = "text" | "photo" | "album_item" | "extra_photo";

export interface TelegramMessageRef {
  chatId: string;
  messageId: number;
  role: TelegramMessageRole;
  mediaIndex?: number;
  mediaUrl?: string;
  telegramFileId?: string;
}

export interface SendTextInput {
  text: string;
}

export interface EditTextInput {
  chatId: string;
  messageId: number;
  text: string;
}

export interface SendPhotoInput {
  photo: NormalizedPhoto;
  caption?: string;
  role?: TelegramMessageRole;
}

export interface SendMediaGroupInput {
  photos: NormalizedPhoto[];
  caption?: string;
  role?: TelegramMessageRole;
}

export interface EditCaptionInput {
  chatId: string;
  messageId: number;
  caption: string;
}

export interface EditMediaInput {
  chatId: string;
  messageId: number;
  photo: NormalizedPhoto;
  caption?: string;
  role?: TelegramMessageRole;
  mediaIndex?: number;
}

export interface DeleteMessageInput {
  chatId: string;
  messageId: number;
}

export interface TelegramClient {
  sendText(input: SendTextInput): Promise<TelegramMessageRef>;
  editText(input: EditTextInput): Promise<TelegramMessageRef>;
  sendPhoto(input: SendPhotoInput): Promise<TelegramMessageRef>;
  sendMediaGroup(input: SendMediaGroupInput): Promise<TelegramMessageRef[]>;
  editCaption(input: EditCaptionInput): Promise<TelegramMessageRef>;
  editMedia(input: EditMediaInput): Promise<TelegramMessageRef>;
  deleteMessage(input: DeleteMessageInput): Promise<void>;
}

export interface TelegramBotApiClientOptions {
  botToken: string;
  chatId: string;
  messageThreadId?: number;
  parseMode?: "HTML" | "MarkdownV2";
  apiBaseUrl?: string;
  photoDownloadTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramApiMessage {
  chat: {
    id: number | string;
  };
  message_id: number;
  photo?: Array<{
    file_id: string;
  }>;
}

export class TelegramBotApiClient implements TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly photoDownloadTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TelegramBotApiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.photoDownloadTimeoutMs = Math.max(
      1,
      options.photoDownloadTimeoutMs ?? 15_000
    );
    this.retryAttempts = Math.max(1, options.retryAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.sleep = options.sleep ?? sleep;
  }

  async sendText(input: SendTextInput): Promise<TelegramMessageRef> {
    const result = await this.call<TelegramApiMessage>("sendMessage", {
      chat_id: this.options.chatId,
      message_thread_id: this.options.messageThreadId,
      text: input.text,
      parse_mode: this.options.parseMode
    });

    return toMessageRef(result, "text");
  }

  async editText(input: EditTextInput): Promise<TelegramMessageRef> {
    const result = await this.call<TelegramApiMessage>("editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      parse_mode: this.options.parseMode
    });

    return toMessageRef(result, "text");
  }

  async sendPhoto(input: SendPhotoInput): Promise<TelegramMessageRef> {
    const photoUrl = requireResolvedPhotoUrl(input.photo);
    let result: TelegramApiMessage;
    try {
      result = await this.call<TelegramApiMessage>("sendPhoto", {
        chat_id: this.options.chatId,
        message_thread_id: this.options.messageThreadId,
        photo: encodePhotoUrl(photoUrl),
        caption: input.caption,
        parse_mode: this.options.parseMode
      });
    } catch (error) {
      if (!shouldUploadPhotoFallback(error)) {
        throw error;
      }

      result = await this.sendPhotoAsUpload(input, photoUrl, error);
    }

    return toMessageRef(result, input.role ?? "photo", 0, photoUrl);
  }

  async sendMediaGroup(input: SendMediaGroupInput): Promise<TelegramMessageRef[]> {
    const photoUrls = input.photos.map(requireResolvedPhotoUrl);
    let result: TelegramApiMessage[];
    try {
      result = await this.call<TelegramApiMessage[]>("sendMediaGroup", {
        chat_id: this.options.chatId,
        message_thread_id: this.options.messageThreadId,
        media: photoUrls.map((photoUrl, index) => ({
          type: "photo",
          media: encodePhotoUrl(photoUrl),
          caption: index === 0 ? input.caption : undefined,
          parse_mode: index === 0 ? this.options.parseMode : undefined
        }))
      });
    } catch (error) {
      if (!shouldUploadPhotoFallback(error)) {
        throw error;
      }

      result = await this.sendMediaGroupAsUpload(input, photoUrls, error);
    }

    return result.map((message, index) =>
      toMessageRef(message, input.role ?? "album_item", index, photoUrls[index])
    );
  }

  async editCaption(input: EditCaptionInput): Promise<TelegramMessageRef> {
    const result = await this.call<TelegramApiMessage>("editMessageCaption", {
      chat_id: input.chatId,
      message_id: input.messageId,
      caption: input.caption,
      parse_mode: this.options.parseMode
    });

    return toMessageRef(result, "photo");
  }

  async editMedia(input: EditMediaInput): Promise<TelegramMessageRef> {
    const photoUrl = requireResolvedPhotoUrl(input.photo);
    let result: TelegramApiMessage;
    try {
      result = await this.call<TelegramApiMessage>("editMessageMedia", {
        chat_id: input.chatId,
        message_id: input.messageId,
        media: {
          type: "photo",
          media: encodePhotoUrl(photoUrl),
          caption: input.caption,
          parse_mode: input.caption ? this.options.parseMode : undefined
        }
      });
    } catch (error) {
      if (!shouldUploadPhotoFallback(error)) {
        throw error;
      }

      result = await this.editMediaAsUpload(input, photoUrl, error);
    }

    return toMessageRef(
      result,
      input.role ?? "photo",
      input.mediaIndex ?? 0,
      photoUrl
    );
  }

  async deleteMessage(input: DeleteMessageInput): Promise<void> {
    await this.call<boolean>("deleteMessage", {
      chat_id: input.chatId,
      message_id: input.messageId
    });
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.callOnce<T>(method, payload);
      } catch (error) {
        lastError = error;
        if (!isRetryableTelegramError(error) || attempt === this.retryAttempts) {
          throw error;
        }

        await this.sleep(getRetryDelayMs(error, this.retryDelayMs, attempt));
      }
    }

    throw lastError;
  }

  private async callOnce<T>(
    method: string,
    payload: Record<string, unknown>
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/bot${this.options.botToken}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(stripUndefined(payload))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TelegramApiCallError(
        `Telegram ${method} failed: ${this.redactMessage(message)}`,
        true
      );
    }

    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !data.ok || data.result === undefined) {
      const message = data.description ?? response.statusText;
      throw new TelegramApiCallError(
        `Telegram ${method} failed: ${this.redactMessage(message)}`,
        isRetryableResponse(response.status),
        data.parameters?.retry_after
      );
    }

    return data.result;
  }

  private async callMultipart<T>(
    method: string,
    formFactory: () => FormData
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await this.callMultipartOnce<T>(method, formFactory());
      } catch (error) {
        lastError = error;
        if (!isRetryableTelegramError(error) || attempt === this.retryAttempts) {
          throw error;
        }

        await this.sleep(getRetryDelayMs(error, this.retryDelayMs, attempt));
      }
    }

    throw lastError;
  }

  private async callMultipartOnce<T>(
    method: string,
    body: FormData
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/bot${this.options.botToken}/${method}`, {
        method: "POST",
        body
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TelegramApiCallError(
        `Telegram ${method} failed: ${this.redactMessage(message)}`,
        true
      );
    }

    return this.parseTelegramResponse<T>(method, response);
  }

  private async parseTelegramResponse<T>(
    method: string,
    response: Response
  ): Promise<T> {
    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !data.ok || data.result === undefined) {
      const message = data.description ?? response.statusText;
      throw new TelegramApiCallError(
        `Telegram ${method} failed: ${this.redactMessage(message)}`,
        isRetryableResponse(response.status),
        data.parameters?.retry_after
      );
    }

    return data.result;
  }

  private async sendPhotoAsUpload(
    input: SendPhotoInput,
    photoUrl: string,
    directError: unknown
  ): Promise<TelegramApiMessage> {
    try {
      const upload = await this.downloadPhotoUpload(photoUrl, "photo");
      return await this.callMultipart<TelegramApiMessage>("sendPhoto", () =>
        toMultipartForm(
          {
            chat_id: this.options.chatId,
            message_thread_id: this.options.messageThreadId,
            caption: input.caption,
            parse_mode: this.options.parseMode
          },
          [upload]
        )
      );
    } catch (fallbackError) {
      throw withFallbackFailureContext(directError, fallbackError);
    }
  }

  private async sendMediaGroupAsUpload(
    input: SendMediaGroupInput,
    photoUrls: string[],
    directError: unknown
  ): Promise<TelegramApiMessage[]> {
    try {
      const uploads = await Promise.all(
        photoUrls.map((photoUrl, index) =>
          this.downloadPhotoUpload(photoUrl, `photo_${index}`)
        )
      );

      return await this.callMultipart<TelegramApiMessage[]>("sendMediaGroup", () =>
        toMultipartForm(
          {
            chat_id: this.options.chatId,
            message_thread_id: this.options.messageThreadId,
            media: uploads.map((upload, index) => ({
              type: "photo",
              media: `attach://${upload.fieldName}`,
              caption: index === 0 ? input.caption : undefined,
              parse_mode: index === 0 ? this.options.parseMode : undefined
            }))
          },
          uploads
        )
      );
    } catch (fallbackError) {
      throw withFallbackFailureContext(directError, fallbackError);
    }
  }

  private async editMediaAsUpload(
    input: EditMediaInput,
    photoUrl: string,
    directError: unknown
  ): Promise<TelegramApiMessage> {
    try {
      const upload = await this.downloadPhotoUpload(photoUrl, "photo");
      return await this.callMultipart<TelegramApiMessage>("editMessageMedia", () =>
        toMultipartForm(
          {
            chat_id: input.chatId,
            message_id: input.messageId,
            media: {
              type: "photo",
              media: `attach://${upload.fieldName}`,
              caption: input.caption,
              parse_mode: input.caption ? this.options.parseMode : undefined
            }
          },
          [upload]
        )
      );
    } catch (fallbackError) {
      throw withFallbackFailureContext(directError, fallbackError);
    }
  }

  private async downloadPhotoUpload(
    photoUrl: string,
    fieldName: string
  ): Promise<PhotoUpload> {
    const encodedUrl = encodePhotoUrl(photoUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.photoDownloadTimeoutMs);

    let response: Response;
    try {
      response = await fetch(encodedUrl, {
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(`Photo download failed: ${this.redactMessage(getErrorMessage(error))}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Photo download failed with HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) {
      throw new Error("Photo download returned an empty file");
    }

    return {
      fieldName,
      blob: new Blob([bytes], { type: contentType }),
      filename: getPhotoFilename(encodedUrl, contentType, fieldName)
    };
  }

  private redactMessage(message: string): string {
    return redactSensitiveText(message, [this.options.botToken]);
  }
}

class TelegramApiCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "TelegramApiCallError";
  }
}

function toMessageRef(
  message: TelegramApiMessage,
  role: TelegramMessageRole,
  mediaIndex?: number,
  mediaUrl?: string
): TelegramMessageRef {
  return {
    chatId: String(message.chat.id),
    messageId: message.message_id,
    role,
    mediaIndex,
    mediaUrl,
    telegramFileId: message.photo?.at(-1)?.file_id
  };
}

function encodePhotoUrl(url: string): string {
  return encodeURI(url);
}

interface PhotoUpload {
  fieldName: string;
  blob: Blob;
  filename: string;
}

function requireResolvedPhotoUrl(photo: NormalizedPhoto): string {
  if (!photo.url || photo.unresolved) {
    const idText = photo.id ? ` ${photo.id}` : "";
    throw new Error(`Cannot send unresolved Bitrix photo id${idText} without URL`);
  }

  return photo.url;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function toMultipartForm(
  fields: Record<string, unknown>,
  uploads: PhotoUpload[]
): FormData {
  const form = new FormData();

  for (const [key, value] of Object.entries(stripUndefined(fields))) {
    form.append(
      key,
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value)
    );
  }

  for (const upload of uploads) {
    form.append(upload.fieldName, upload.blob, upload.filename);
  }

  return form;
}

function isRetryableResponse(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiCallError && error.retryable;
}

function shouldUploadPhotoFallback(error: unknown): boolean {
  if (!(error instanceof TelegramApiCallError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return [
    "failed to get http url content",
    "failed to get url content",
    "wrong file identifier/http url specified",
    "invalid file http url specified",
    "wrong type of the web page content",
    "url host is empty"
  ].some((pattern) => message.includes(pattern));
}

function withFallbackFailureContext(
  directError: unknown,
  fallbackError: unknown
): Error {
  return new Error(
    [
      getErrorMessage(directError),
      `Multipart photo fallback failed: ${getErrorMessage(fallbackError)}`
    ].join(". ")
  );
}

function getPhotoFilename(
  encodedUrl: string,
  contentType: string,
  fallbackName: string
): string {
  let filename = fallbackName;
  try {
    const parsed = new URL(encodedUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (lastSegment) {
      filename = decodeURIComponent(lastSegment);
    }
  } catch {
    filename = fallbackName;
  }

  const sanitized = sanitizeFilename(filename) || fallbackName;
  if (/\.[a-z0-9]{2,5}$/i.test(sanitized)) {
    return sanitized;
  }

  return `${sanitized}${extensionFromContentType(contentType)}`;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
}

function extensionFromContentType(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".jpg";
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRetryDelayMs(
  error: unknown,
  baseDelayMs: number,
  attempt: number
): number {
  if (
    error instanceof TelegramApiCallError &&
    error.retryAfterSeconds !== undefined
  ) {
    return Math.max(0, error.retryAfterSeconds * 1000);
  }

  return baseDelayMs * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
