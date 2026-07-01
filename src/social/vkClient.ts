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

export interface VkClientOptions {
  communityToken: string;
  userAccessToken?: string;
  groupId: string;
  apiVersion?: string;
  postAsGroup?: boolean;
  apiBaseUrl?: string;
  photoDownloadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
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
  server: number;
  photo?: string;
  photos_list?: string;
  hash: string;
}

interface VkSavedPhoto {
  owner_id: number;
  id: number;
  access_key?: string;
}

export class VkClient implements ExternalSocialPublisher {
  readonly target = "vk" as const;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly photoDownloadTimeoutMs: number;

  constructor(private readonly options: VkClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.vk.com/method").replace(
      /\/+$/,
      ""
    );
    this.apiVersion = options.apiVersion ?? "5.199";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.photoDownloadTimeoutMs = Math.max(1, options.photoDownloadTimeoutMs ?? 15_000);
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
    if (!this.options.userAccessToken) {
      throw new Error("VK_ACCESS_TOKEN is required to upload wall photos");
    }

    if (!photo.url || photo.unresolved) {
      throw new Error(`Cannot upload unresolved Bitrix photo id ${photo.id ?? "unknown"}`);
    }

    const uploadServer = await this.callVk<VkWallUploadServerResponse>(
      "photos.getWallUploadServer",
      {
        group_id: this.options.groupId
      },
      this.options.userAccessToken
    );
    const file = await downloadPhoto(photo.url, {
      timeoutMs: this.photoDownloadTimeoutMs,
      fetchImpl: this.fetchImpl,
      secrets: [this.options.communityToken, this.options.userAccessToken]
    });
    const form = new FormData();
    form.append("photo", file.blob, file.filename);
    const uploadResponse = await this.fetchUpload<VkWallUploadResponse>(
      uploadServer.upload_url,
      form
    );
    const saved = await this.callVk<VkSavedPhoto[]>(
      "photos.saveWallPhoto",
      {
        group_id: this.options.groupId,
        server: String(uploadResponse.server),
        photo: getUploadedPhotoPayload(uploadResponse),
        hash: uploadResponse.hash
      },
      this.options.userAccessToken
    );
    const first = saved[0];
    if (!first) {
      throw new Error("VK saveWallPhoto returned no photos");
    }

    return `photo${first.owner_id}_${first.id}${first.access_key ? `_${first.access_key}` : ""}`;
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

  private async fetchUpload<T>(url: string, body: FormData): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      body
    });
    const data = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      throw new Error(`VK photo upload failed with HTTP ${response.status}`);
    }

    return data;
  }
}

function getUploadedPhotoPayload(uploadResponse: VkWallUploadResponse): string {
  const payload = uploadResponse.photo ?? uploadResponse.photos_list;
  if (!payload) {
    throw new Error("VK wall photo upload response did not include photo payload");
  }

  return payload;
}
