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
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TelegramBotApiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
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
    const result = await this.call<TelegramApiMessage>("sendPhoto", {
      chat_id: this.options.chatId,
      message_thread_id: this.options.messageThreadId,
      photo: encodePhotoUrl(photoUrl),
      caption: input.caption,
      parse_mode: this.options.parseMode
    });

    return toMessageRef(result, input.role ?? "photo", 0, photoUrl);
  }

  async sendMediaGroup(input: SendMediaGroupInput): Promise<TelegramMessageRef[]> {
    const photoUrls = input.photos.map(requireResolvedPhotoUrl);
    const result = await this.call<TelegramApiMessage[]>("sendMediaGroup", {
      chat_id: this.options.chatId,
      message_thread_id: this.options.messageThreadId,
      media: photoUrls.map((photoUrl, index) => ({
        type: "photo",
        media: encodePhotoUrl(photoUrl),
        caption: index === 0 ? input.caption : undefined,
        parse_mode: index === 0 ? this.options.parseMode : undefined
      }))
    });

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
    const result = await this.call<TelegramApiMessage>("editMessageMedia", {
      chat_id: input.chatId,
      message_id: input.messageId,
      media: {
        type: "photo",
        media: encodePhotoUrl(photoUrl),
        caption: input.caption,
        parse_mode: input.caption ? this.options.parseMode : undefined
      }
    });

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

function isRetryableResponse(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableTelegramError(error: unknown): boolean {
  return error instanceof TelegramApiCallError && error.retryable;
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
