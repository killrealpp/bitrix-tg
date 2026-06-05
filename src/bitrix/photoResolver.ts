import type { NormalizedPhoto } from "./parseWebhook";
import { redactSensitiveText } from "../security/redaction";

export interface BitrixPhotoResolver {
  resolvePhotos(photos: NormalizedPhoto[]): Promise<NormalizedPhoto[]>;
}

export interface HttpBitrixPhotoResolverOptions {
  endpointUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ResolverPhotoResponse {
  id?: unknown;
  url?: unknown;
  path?: unknown;
}

export class HttpBitrixPhotoResolver implements BitrixPhotoResolver {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpBitrixPhotoResolverOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolvePhotos(photos: NormalizedPhoto[]): Promise<NormalizedPhoto[]> {
    const ids = getUnresolvedPhotoIds(photos);
    if (ids.length === 0) {
      return photos;
    }

    const resolvedPhotos = await this.fetchResolvedPhotos(ids);
    const resolvedById = new Map(
      resolvedPhotos
        .filter((photo) => photo.id && photo.url)
        .map((photo) => [photo.id, photo])
    );

    return photos.map((photo) => {
      if (!isUnresolvedPhoto(photo) || !photo.id) {
        return photo;
      }

      const resolved = resolvedById.get(photo.id);
      if (!resolved?.url) {
        return photo;
      }

      return {
        id: photo.id,
        url: resolved.url,
        path: resolved.path ?? photo.path
      };
    });
  }

  private async fetchResolvedPhotos(ids: string[]): Promise<NormalizedPhoto[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ ids }),
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(
        `Bitrix photo resolver request failed: ${redactErrorMessage(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `Bitrix photo resolver returned invalid JSON: ${redactErrorMessage(error)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Bitrix photo resolver failed with HTTP ${response.status}: ${getResolverError(data)}`
      );
    }

    if (!isRecord(data) || !Array.isArray(data.photos)) {
      throw new Error("Bitrix photo resolver response must contain photos array");
    }

    return data.photos.flatMap(normalizeResolverPhoto);
  }
}

export function getUnresolvedPhotoIds(photos: NormalizedPhoto[]): string[] {
  return Array.from(
    new Set(
      photos
        .filter(isUnresolvedPhoto)
        .map((photo) => photo.id?.trim())
        .filter((id): id is string => Boolean(id))
    )
  );
}

export function getUnresolvedPhotoError(
  photos: NormalizedPhoto[]
): string | null {
  const unresolvedIds = getUnresolvedPhotoIds(photos);
  if (unresolvedIds.length === 0) {
    return null;
  }

  return [
    `Unresolved Bitrix photo id without URL: ${unresolvedIds.join(", ")}`,
    "Configure body.all_properties.PHOTOS as URL objects or BITRIX_FILE_RESOLVER_URL before publishing."
  ].join(". ");
}

export function hasUnresolvedPhotos(photos: NormalizedPhoto[]): boolean {
  return getUnresolvedPhotoIds(photos).length > 0;
}

function normalizeResolverPhoto(photo: unknown): NormalizedPhoto[] {
  if (!isRecord(photo)) {
    return [];
  }

  const response = photo as ResolverPhotoResponse;
  const id = optionalString(response.id);
  const url = optionalString(response.url);
  if (!id || !url) {
    return [];
  }

  return [
    {
      id,
      url,
      path: optionalString(response.path)
    }
  ];
}

function isUnresolvedPhoto(photo: NormalizedPhoto): boolean {
  return Boolean(photo.unresolved || !photo.url);
}

function getResolverError(data: unknown): string {
  if (isRecord(data)) {
    const message = data.error ?? data.message ?? data.description;
    if (message !== undefined && message !== null) {
      return redactSensitiveText(String(message));
    }
  }

  return "unknown error";
}

function redactErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
