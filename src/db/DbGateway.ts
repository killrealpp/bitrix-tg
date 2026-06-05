import type { NormalizedPhoto } from "../bitrix/parseWebhook";
import type { TelegramMessageRole } from "../telegram/client";

export type PostStatus = "ignored" | "scheduled" | "publishing" | "published" | "failed";
export type PublicationKind = "text" | "photo" | "media_group" | "mixed";

export interface StoredBitrixPost {
  id: number;
  bitrixId: number;
  status: PostStatus;
  chatId: string | null;
  mainMessageId: number | null;
  publicationKind: PublicationKind | null;
  scheduledAt: Date | null;
  sourceText: string;
  telegramText: string | null;
  photos: NormalizedPhoto[];
  payloadHash: string;
  lastError: string | null;
  scheduledRetryCount: number;
  adminNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistPostInput {
  bitrixId: number;
  status: PostStatus;
  chatId?: string | null;
  mainMessageId?: number | null;
  publicationKind?: PublicationKind | null;
  scheduledAt?: Date | null;
  sourceText: string;
  telegramText?: string | null;
  photos: NormalizedPhoto[];
  payloadHash: string;
  lastError?: string | null;
  scheduledRetryCount?: number;
  adminNotifiedAt?: Date | null;
}

export type UpdatePostPatch = Partial<Omit<PersistPostInput, "bitrixId">>;

export interface StoredTelegramMessage {
  id: number;
  postId: number;
  chatId: string;
  tgMessageId: number;
  role: TelegramMessageRole;
  mediaIndex: number | null;
  mediaUrl: string | null;
  telegramFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistTelegramMessageInput {
  chatId: string;
  tgMessageId: number;
  role: TelegramMessageRole;
  mediaIndex?: number | null;
  mediaUrl?: string | null;
  telegramFileId?: string | null;
}

export interface DbGateway {
  findPostByBitrixId(bitrixId: number): Promise<StoredBitrixPost | null>;
  createPost(input: PersistPostInput): Promise<StoredBitrixPost>;
  updatePost(id: number, patch: UpdatePostPatch): Promise<StoredBitrixPost>;
  replaceTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void>;
  appendTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void>;
  listTelegramMessages(postId: number): Promise<StoredTelegramMessage[]>;
  findDueScheduledPosts(now: Date, limit: number): Promise<StoredBitrixPost[]>;
  close(): Promise<void>;
}
