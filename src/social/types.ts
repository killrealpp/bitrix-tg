import type { NormalizedPhoto, PublishTarget } from "../bitrix/parseWebhook";
import type { PublicationKind } from "../db/DbGateway";

export type ExternalSocialTarget = Exclude<PublishTarget, "telegram">;

export interface ExternalPublishInput {
  bitrixId: number;
  text: string;
  photos: NormalizedPhoto[];
  payloadHash: string;
}

export interface ExternalPublishResult {
  target: ExternalSocialTarget;
  externalId: string;
  externalChatId?: string;
  publicationKind: PublicationKind;
  sentText: string;
  photos: NormalizedPhoto[];
}

export interface ExternalDeleteInput {
  externalId: string;
  externalChatId?: string | null;
}

export interface ExternalSocialPublisher {
  target: ExternalSocialTarget;
  publish(input: ExternalPublishInput): Promise<ExternalPublishResult>;
  delete(input: ExternalDeleteInput): Promise<void>;
}

export function publicationKindForPhotos(photos: NormalizedPhoto[]): PublicationKind {
  if (photos.length === 0) {
    return "text";
  }

  return photos.length === 1 ? "photo" : "media_group";
}
