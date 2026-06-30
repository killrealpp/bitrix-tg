import { redactSensitiveText } from "../security/redaction";

export interface DownloadedPhoto {
  blob: Blob;
  filename: string;
  contentType: string;
}

export async function downloadPhoto(
  photoUrl: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    secrets?: string[];
  } = {}
): Promise<DownloadedPhoto> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const encodedUrl = encodeURI(photoUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetchImpl(encodedUrl, {
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(
      `Photo download failed: ${redactSensitiveText(getErrorMessage(error), options.secrets)}`
    );
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
    blob: new Blob([bytes], { type: contentType }),
    filename: getPhotoFilename(encodedUrl, contentType),
    contentType
  };
}

function getPhotoFilename(encodedUrl: string, contentType: string): string {
  let filename = "photo";
  try {
    const parsed = new URL(encodedUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (lastSegment) {
      filename = decodeURIComponent(lastSegment);
    }
  } catch {
    filename = "photo";
  }

  const sanitized = filename.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim() || "photo";
  if (/\.[a-z0-9]{2,5}$/i.test(sanitized)) {
    return sanitized;
  }

  return `${sanitized}${extensionFromContentType(contentType)}`;
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
