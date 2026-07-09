import { randomUUID } from "node:crypto";
import type { NormalizedPhoto } from "../bitrix/parseWebhook";
import { redactSensitiveText } from "../security/redaction";
import { downloadPhoto, type DownloadedPhoto } from "./photoDownload";
import {
  publicationKindForPhotos,
  type ExternalDeleteInput,
  type ExternalPublishInput,
  type ExternalPublishResult,
  type ExternalSocialPublisher
} from "./types";
import type { VkUserAccessTokenProvider } from "./vkOAuth";

export interface VkClientOptions {
  communityToken: string;
  userAccessToken?: string;
  userAccessTokenProvider?: VkUserAccessTokenProvider;
  groupId: string;
  apiVersion?: string;
  postAsGroup?: boolean;
  apiBaseUrl?: string;
  photoDownloadTimeoutMs?: number;
  uploadRetryAttempts?: number;
  uploadRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface VkApiResponse<T> {
  response?: T;
  error?: {
    error_code?: number;
    error_msg?: string;
  };
}

interface VkWallPostResponse {
  post_id: number;
}

interface VkWallUploadServerResponse {
  upload_url: string;
}

interface VkWallUploadResponse {
  server?: unknown;
  photo?: unknown;
  photos_list?: unknown;
  hash?: unknown;
}

interface VkSavedPhoto {
  owner_id: number;
  id: number;
  access_key?: string;
}

interface VkUploadBody {
  body: NonNullable<RequestInit["body"]>;
  headers: Record<string, string>;
}

export class VkClient implements ExternalSocialPublisher {
  readonly target = "vk" as const;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly photoDownloadTimeoutMs: number;
  private readonly uploadRetryAttempts: number;
  private readonly uploadRetryDelayMs: number;

  constructor(private readonly options: VkClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.vk.com/method").replace(
      /\/+$/,
      ""
    );
    this.apiVersion = options.apiVersion ?? "5.199";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleep;
    this.photoDownloadTimeoutMs = Math.max(1, options.photoDownloadTimeoutMs ?? 15_000);
    this.uploadRetryAttempts = Math.max(1, options.uploadRetryAttempts ?? 3);
    this.uploadRetryDelayMs = Math.max(0, options.uploadRetryDelayMs ?? 1000);
  }

  async publish(input: ExternalPublishInput): Promise<ExternalPublishResult> {
    const attachments = [];
    for (const photo of input.photos) {
      attachments.push(await this.uploadWallPhoto(photo));
    }

    const response = await this.callVk<VkWallPostResponse>(
      "wall.post",
      {
        owner_id: String(-Math.abs(Number(this.options.groupId))),
        from_group: this.options.postAsGroup === false ? "0" : "1",
        message: input.text,
        attachments: attachments.length > 0 ? attachments.join(",") : undefined,
        guid: `${input.bitrixId}-${input.payloadHash.slice(0, 16)}`
      },
      this.options.communityToken
    );

    return {
      target: this.target,
      externalId: String(response.post_id),
      externalChatId: this.options.groupId,
      publicationKind: publicationKindForPhotos(input.photos),
      sentText: input.text,
      photos: input.photos
    };
  }

  async delete(input: ExternalDeleteInput): Promise<void> {
    await this.callVk<unknown>(
      "wall.delete",
      {
        owner_id: String(-Math.abs(Number(input.externalChatId ?? this.options.groupId))),
        post_id: input.externalId
      },
      this.options.communityToken
    );
  }

  private async uploadWallPhoto(photo: NormalizedPhoto): Promise<string> {
    const userAccessToken = await this.getUserAccessToken();
    if (!userAccessToken) {
      throw new Error("VK_ACCESS_TOKEN is required to upload wall photos");
    }

    try {
      return await this.uploadWallPhotoWithToken(photo, userAccessToken);
    } catch (error) {
      if (!isInvalidAccessTokenError(error) || !this.options.userAccessTokenProvider) {
        throw error;
      }

      const refreshedToken =
        await this.options.userAccessTokenProvider.refreshAccessToken();
      return this.uploadWallPhotoWithToken(photo, refreshedToken);
    }
  }

  private async uploadWallPhotoWithToken(
    photo: NormalizedPhoto,
    userAccessToken: string
  ): Promise<string> {

    if (!photo.url || photo.unresolved) {
      throw new Error(`Cannot upload unresolved Bitrix photo id ${photo.id ?? "unknown"}`);
    }

    const file = await downloadPhoto(photo.url, {
      timeoutMs: this.photoDownloadTimeoutMs,
      fetchImpl: this.fetchImpl,
      secrets: [this.options.communityToken, userAccessToken]
    });
    const { uploadResponse, saveParams } = await this.uploadWallPhotoWithRetry(
      file,
      userAccessToken
    );
    let saved: VkSavedPhoto[];
    try {
      saved = await this.callVk<VkSavedPhoto[]>(
        "photos.saveWallPhoto",
        saveParams,
        userAccessToken
      );
    } catch (error) {
      throw new Error(
        `${getErrorMessage(error)} (${summarizeVkUploadResponse(uploadResponse)})`
      );
    }
    const first = saved[0];
    if (!first) {
      throw new Error("VK saveWallPhoto returned no photos");
    }

    return `photo${first.owner_id}_${first.id}${first.access_key ? `_${first.access_key}` : ""}`;
  }

  private async getUserAccessToken(): Promise<string | undefined> {
    if (this.options.userAccessTokenProvider) {
      return this.options.userAccessTokenProvider.getAccessToken();
    }

    return this.options.userAccessToken;
  }

  private async uploadWallPhotoWithRetry(
    file: DownloadedPhoto,
    userAccessToken: string
  ): Promise<{
    uploadResponse: VkWallUploadResponse;
    saveParams: Record<string, string>;
  }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.uploadRetryAttempts; attempt += 1) {
      const uploadServer = await this.callVk<VkWallUploadServerResponse>(
        "photos.getWallUploadServer",
        {
          group_id: this.options.groupId
        },
        userAccessToken
      );
      const uploadBody = await createPhotoUploadBody(file);
      const uploadResponse = await this.fetchUpload<VkWallUploadResponse>(
        uploadServer.upload_url,
        uploadBody
      );

      try {
        return {
          uploadResponse,
          saveParams: {
            group_id: this.options.groupId,
            server: getUploadedPhotoServer(uploadResponse),
            photo: getUploadedPhotoPayload(uploadResponse),
            hash: getUploadedPhotoHash(uploadResponse)
          }
        };
      } catch (error) {
        if (!(error instanceof VkUploadPayloadError)) {
          throw error;
        }

        if (attempt === this.uploadRetryAttempts) {
          throw new Error(`${error.message}; ${summarizeDownloadedPhoto(file)}`);
        }

        lastError = error;
        await this.sleep(this.uploadRetryDelayMs * attempt);
      }
    }

    throw normalizeUploadError(lastError);
  }

  private async callVk<T>(
    method: string,
    params: Record<string, string | undefined>,
    token: string
  ): Promise<T> {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("v", this.apiVersion);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        body.set(key, value);
      }
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const data = (await response.json().catch(() => ({}))) as VkApiResponse<T>;
    if (!response.ok || data.error || data.response === undefined) {
      const message = data.error
        ? `${data.error.error_code ?? "unknown"} ${data.error.error_msg ?? "unknown error"}`
        : `HTTP ${response.status}`;
      throw new Error(
        `VK ${method} failed: ${redactSensitiveText(message, [
          this.options.communityToken,
          this.options.userAccessToken
        ])}`
      );
    }

    return data.response;
  }

  private async fetchUpload<T>(url: string, upload: VkUploadBody): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.uploadRetryAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: upload.headers,
          body: upload.body
        });
        const data = (await response.json().catch(() => ({}))) as T;
        if (response.ok) {
          return data;
        }

        const error = new VkUploadHttpError(response.status);
        if (!isRetriableUploadError(error) || attempt === this.uploadRetryAttempts) {
          throw error;
        }

        lastError = error;
      } catch (error) {
        if (!isRetriableUploadError(error) || attempt === this.uploadRetryAttempts) {
          throw normalizeUploadError(error);
        }

        lastError = error;
      }

      await this.sleep(this.uploadRetryDelayMs * attempt);
    }

    throw normalizeUploadError(lastError);
  }
}

class VkUploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`VK photo upload failed with HTTP ${status}`);
    this.name = "VkUploadHttpError";
  }
}

class VkUploadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VkUploadPayloadError";
  }
}

async function createPhotoUploadBody(file: DownloadedPhoto): Promise<VkUploadBody> {
  const boundary = `----bitrix-tg-vk-${randomUUID().replace(/-/g, "")}`;
  const contentType = normalizeMultipartContentType(file.contentType);
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="photo"; filename="${escapeMultipartValue(
      file.filename
    )}"`,
    `Content-Type: ${contentType}`,
    "",
    ""
  ].join("\r\n");
  const footer = `\r\n--${boundary}--\r\n`;
  const encoder = new TextEncoder();
  const body = concatUint8Arrays([
    encoder.encode(header),
    new Uint8Array(await file.blob.arrayBuffer()),
    encoder.encode(footer)
  ]);

  return {
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength)
    }
  };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function normalizeMultipartContentType(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type || "application/octet-stream";
}

function escapeMultipartValue(value: string): string {
  return value.replace(/[\r\n"]/g, "_").replace(/\\/g, "_");
}

function summarizeDownloadedPhoto(file: DownloadedPhoto): string {
  return `uploaded file: bytes=${file.blob.size}, contentType=${normalizeMultipartContentType(
    file.contentType
  )}, filename=${file.filename}`;
}

function getUploadedPhotoPayload(uploadResponse: VkWallUploadResponse): string {
  const payload = stringifyUploadPayload(uploadResponse.photo ?? uploadResponse.photos_list);
  if (!payload || payload === "[]" || payload === "{}" || payload === "null") {
    throw new VkUploadPayloadError(
      `VK wall photo upload returned empty photo payload (${summarizeVkUploadResponse(
        uploadResponse
      )})`
    );
  }

  return payload;
}

function getUploadedPhotoServer(uploadResponse: VkWallUploadResponse): string {
  const value = uploadResponse.server;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new VkUploadPayloadError(
      `VK wall photo upload response did not include server (${summarizeVkUploadResponse(
        uploadResponse
      )})`
    );
  }

  return String(value);
}

function getUploadedPhotoHash(uploadResponse: VkWallUploadResponse): string {
  const value = uploadResponse.hash;
  if (typeof value !== "string" || !value) {
    throw new VkUploadPayloadError(
      `VK wall photo upload response did not include hash (${summarizeVkUploadResponse(
        uploadResponse
      )})`
    );
  }

  return value;
}

function stringifyUploadPayload(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value === undefined) {
    return "";
  }

  const text = JSON.stringify(value);
  return typeof text === "string" ? text.trim() : "";
}

function summarizeVkUploadResponse(uploadResponse: VkWallUploadResponse): string {
  const payloadField =
    uploadResponse.photo !== undefined
      ? "photo"
      : uploadResponse.photos_list !== undefined
        ? "photos_list"
        : "none";
  const payload = stringifyUploadPayload(
    uploadResponse.photo ?? uploadResponse.photos_list
  );
  const server =
    typeof uploadResponse.server === "string" || typeof uploadResponse.server === "number"
      ? String(uploadResponse.server)
      : "missing";
  const hash =
    typeof uploadResponse.hash === "string" && uploadResponse.hash
      ? "present"
      : "missing";

  return `upload response: server=${server}, hash=${hash}, payloadField=${payloadField}, payloadLength=${payload.length}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetriableUploadError(error: unknown): boolean {
  if (error instanceof VkUploadHttpError) {
    return error.status === 429 || error.status >= 500;
  }

  return true;
}

function normalizeUploadError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isInvalidAccessTokenError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("invalid_token") ||
    message.includes("access token not existed") ||
    message.includes("access_token has expired") ||
    (message.includes("access token") && message.includes("invalid")) ||
    (message.includes("access_token") && message.includes("invalid"))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
