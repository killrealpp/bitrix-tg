import type { NormalizedPhoto } from "../bitrix/parseWebhook";
import { redactSensitiveText } from "../security/redaction";
import { downloadPhoto } from "./photoDownload";
import {
  publicationKindForPhotos,
  type ExternalDeleteInput,
  type ExternalPublishInput,
  type ExternalPublishResult,
  type ExternalSocialPublisher
} from "./types";

export interface MaxClientOptions {
  token: string;
  chatId: string;
  apiBaseUrl?: string;
  photoDownloadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface MaxMessageResponse {
  message?: unknown;
  id?: unknown;
  message_id?: unknown;
  mid?: unknown;
  body?: {
    mid?: unknown;
    message_id?: unknown;
  };
  code?: unknown;
  message_text?: unknown;
}

interface MaxUploadUrlResponse {
  url?: unknown;
  token?: unknown;
}

interface MaxUploadCompleteResponse {
  token?: unknown;
}

export class MaxClient implements ExternalSocialPublisher {
  readonly target = "max" as const;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly photoDownloadTimeoutMs: number;

  constructor(private readonly options: MaxClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://platform-api2.max.ru").replace(
      /\/+$/,
      ""
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleep;
    this.photoDownloadTimeoutMs = Math.max(1, options.photoDownloadTimeoutMs ?? 15_000);
  }

  async publish(input: ExternalPublishInput): Promise<ExternalPublishResult> {
    const attachments = [];
    for (const photo of input.photos) {
      attachments.push({
        type: "image",
        payload: await this.uploadImage(photo)
      });
    }

    const body = {
      text: input.text,
      attachments: attachments.length > 0 ? attachments : undefined
    };

    const data = await this.sendMessageWithAttachmentRetry(body);

    return {
      target: this.target,
      externalId: extractMessageId(data),
      externalChatId: this.options.chatId,
      publicationKind: publicationKindForPhotos(input.photos),
      sentText: input.text,
      photos: input.photos
    };
  }

  private async sendMessageWithAttachmentRetry(
    body: Record<string, unknown>
  ): Promise<MaxMessageResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.requestJson<MaxMessageResponse>(
          `/messages?chat_id=${encodeURIComponent(this.options.chatId)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(stripUndefined(body))
          }
        );
      } catch (error) {
        lastError = error;
        if (!isAttachmentNotReadyError(error) || attempt === 3) {
          throw error;
        }

        await this.sleep(1000 * attempt);
      }
    }

    throw lastError;
  }

  async delete(input: ExternalDeleteInput): Promise<void> {
    const messageId = input.externalId;
    await this.requestJson<unknown>(
      `/messages/${encodeURIComponent(messageId)}?chat_id=${encodeURIComponent(
        input.externalChatId ?? this.options.chatId
      )}`,
      {
        method: "DELETE"
      }
    );
  }

  private async uploadImage(photo: NormalizedPhoto): Promise<Record<string, unknown>> {
    if (!photo.url || photo.unresolved) {
      throw new Error(`Cannot upload unresolved Bitrix photo id ${photo.id ?? "unknown"}`);
    }

    const upload = await this.requestJson<MaxUploadUrlResponse>("/uploads?type=image", {
      method: "POST"
    });
    const uploadUrl = getStringField(upload, "url");
    const photoFile = await downloadPhoto(photo.url, {
      timeoutMs: this.photoDownloadTimeoutMs,
      fetchImpl: this.fetchImpl,
      secrets: [this.options.token]
    });
    const form = new FormData();
    form.append("data", photoFile.blob, photoFile.filename);

    const uploaded = await this.fetchUpload<MaxUploadCompleteResponse>(uploadUrl, {
      method: "POST",
      body: form
    });
    const token =
      getOptionalStringField(uploaded, "token") ??
      getOptionalStringField(upload, "token") ??
      extractTokenFromUploadUrl(uploadUrl);
    if (!token) {
      throw new Error("MAX image upload did not return a token");
    }

    return {
      token
    };
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.apiBaseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          authorization: this.options.token,
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      throw new Error(
        `MAX ${path} fetch failed: ${redactSensitiveText(getErrorMessage(error), [
          this.options.token
        ])}`
      );
    }

    return this.parseResponse<T>(response, path);
  }

  private async fetchUpload<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          authorization: this.options.token,
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      throw new Error(
        `MAX upload fetch failed: ${redactSensitiveText(getErrorMessage(error), [
          this.options.token
        ])}`
      );
    }

    return this.parseResponse<T>(response, "upload");
  }

  private async parseResponse<T>(response: Response, operation: string): Promise<T> {
    const data = (await response.json().catch(() => ({}))) as T;
    if (isAttachmentNotReady(data)) {
      throw new MaxAttachmentNotReadyError();
    }

    if (!response.ok) {
      const message = extractErrorMessage(data);
      throw new Error(
        `MAX ${operation} failed with HTTP ${response.status}: ${redactSensitiveText(
          message,
          [this.options.token]
        )}`
      );
    }

    return data;
  }
}

class MaxAttachmentNotReadyError extends Error {
  constructor() {
    super("MAX attachment is not ready");
    this.name = "MaxAttachmentNotReadyError";
  }
}

function extractMessageId(data: MaxMessageResponse): string {
  const message = data.message && typeof data.message === "object" ? data.message : data;
  const record = message as Record<string, unknown>;
  const id =
    record.id ??
    record.message_id ??
    record.mid ??
    (record.body && typeof record.body === "object"
      ? (record.body as Record<string, unknown>).mid ??
        (record.body as Record<string, unknown>).message_id
      : undefined);
  const text = typeof id === "string" || typeof id === "number" ? String(id) : "";
  if (!text) {
    throw new Error("MAX send message response did not include message id");
  }

  return text;
}

function getStringField(record: object, field: string): string {
  const value = getOptionalStringField(record, field);
  if (!value) {
    throw new Error(`MAX response did not include ${field}`);
  }

  return value;
}

function getOptionalStringField(record: object, field: string): string | null {
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractTokenFromUploadUrl(uploadUrl: string): string | null {
  try {
    const parsed = new URL(uploadUrl);
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

function extractErrorMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const value = record.message ?? record.error ?? record.description ?? record.code;
    if (typeof value === "string") {
      return value;
    }
  }

  return "unknown error";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }

  return String(error);
}

function isAttachmentNotReady(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }

  const record = data as Record<string, unknown>;
  return record.code === "attachment.not.ready";
}

function isAttachmentNotReadyError(error: unknown): boolean {
  return error instanceof MaxAttachmentNotReadyError;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
