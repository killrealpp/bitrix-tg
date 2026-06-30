import {
  getUnresolvedPhotoError,
  hasUnresolvedPhotos,
  type BitrixPhotoResolver
} from "../bitrix/photoResolver";
import type { DbGateway, PublicationKind, StoredBitrixPost } from "../db/DbGateway";
import {
  fitForMaxText,
  fitForTelegramCaption,
  fitForTelegramText,
  fitForVkPost,
  type TextFitOptions
} from "../text/fitText";
import { redactSensitiveText } from "../security/redaction";
import type {
  ExternalSocialPublisher,
  ExternalSocialTarget
} from "../social/types";
import type { TelegramClient, TelegramMessageRef } from "../telegram/client";

export interface RunDuePostsDeps {
  db: DbGateway;
  telegram: TelegramClient;
  externalPublishers?: Partial<Record<ExternalSocialTarget, ExternalSocialPublisher>>;
  textFit?: TextFitOptions;
  now?: Date;
  limit?: number;
  scheduledRetryDelayMs?: number;
  maxScheduledRetries?: number;
  adminNotifier?: ScheduledFailureAdminNotifier;
  photoResolver?: BitrixPhotoResolver;
}

export interface ScheduledFailureAdminNotifier {
  notifyScheduledPublishFailure(input: {
    bitrixId: number;
    error: string;
    retryCount: number;
  }): Promise<void>;
}

export interface RunDuePostsResult {
  checked: number;
  published: number;
  failed: number;
}

export async function runDuePosts(deps: RunDuePostsDeps): Promise<RunDuePostsResult> {
  const now = deps.now ?? new Date();
  const retryDelayMs = deps.scheduledRetryDelayMs ?? 5 * 60 * 1000;
  const maxScheduledRetries = deps.maxScheduledRetries ?? 1;
  const posts = await deps.db.findDueScheduledPosts(now, deps.limit ?? 25);
  let published = 0;
  let failed = 0;

  for (const post of posts) {
    try {
      await deps.db.updatePost(post.id, {
        status: "publishing",
        lastError: null
      });
      const resolvedPost = await resolveStoredPostPhotos(post, deps.photoResolver);
      const result = await publishStoredPostToTargets(resolvedPost, deps);
      const main = result.telegramMessages[0];
      await deps.db.updatePost(post.id, {
        status: "published",
        chatId: main?.chatId ?? null,
        mainMessageId: main?.messageId ?? null,
        publicationKind: result.telegramKind,
        telegramText: result.telegramText,
        photos: resolvedPost.photos,
        lastError: null,
        scheduledRetryCount: 0,
        adminNotifiedAt: null
      });
      await deps.db.replaceTelegramMessages(
        post.id,
        result.telegramMessages.map((message) => ({
          chatId: message.chatId,
          tgMessageId: message.messageId,
          role: message.role,
          mediaIndex: message.mediaIndex ?? null,
          mediaUrl: message.mediaUrl ?? null,
          telegramFileId: message.telegramFileId ?? null
        }))
      );
      published += 1;
    } catch (error) {
      failed += 1;
      const message = redactErrorMessage(error);

      if (post.scheduledRetryCount < maxScheduledRetries) {
        await deps.db.updatePost(post.id, {
          status: "scheduled",
          scheduledAt: new Date(now.getTime() + retryDelayMs),
          lastError: message,
          scheduledRetryCount: post.scheduledRetryCount + 1,
          adminNotifiedAt: null
        });
        continue;
      }

      let adminNotifiedAt: Date | null = null;
      if (deps.adminNotifier) {
        try {
          await deps.adminNotifier.notifyScheduledPublishFailure({
            bitrixId: post.bitrixId,
            error: message,
            retryCount: post.scheduledRetryCount
          });
          adminNotifiedAt = now;
        } catch {
          adminNotifiedAt = null;
        }
      }

      await deps.db.updatePost(post.id, {
        status: "failed",
        lastError: message,
        adminNotifiedAt
      });
    }
  }

  return {
    checked: posts.length,
    published,
    failed
  };
}

function redactErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

async function resolveStoredPostPhotos(
  post: StoredBitrixPost,
  photoResolver?: BitrixPhotoResolver
): Promise<StoredBitrixPost> {
  if (!hasUnresolvedPhotos(post.photos)) {
    return post;
  }

  const photos = photoResolver
    ? await photoResolver.resolvePhotos(post.photos)
    : post.photos;
  const unresolvedPhotoError = getUnresolvedPhotoError(photos);
  if (unresolvedPhotoError) {
    throw new Error(unresolvedPhotoError);
  }

  return {
    ...post,
    photos
  };
}

async function publishStoredPostToTargets(
  post: StoredBitrixPost,
  deps: RunDuePostsDeps
): Promise<{
  telegramKind: PublicationKind | null;
  telegramText: string | null;
  telegramMessages: TelegramMessageRef[];
}> {
  const sourceText = post.preparedText ?? post.sourceText;
  let telegramKind: PublicationKind | null = null;
  let telegramText: string | null = null;
  let telegramMessages: TelegramMessageRef[] = [];

  if (post.publishTargets.telegram) {
    const result = await publishStoredPost(
      post,
      deps.telegram,
      sourceText,
      post.preparedText ? undefined : deps.textFit
    );
    telegramKind = result.kind;
    telegramText = result.telegramText;
    telegramMessages = result.messages;
    const main = telegramMessages[0];
    if (main) {
      await deps.db.upsertSocialPublication(post.id, {
        target: "telegram",
        status: "published",
        externalId: String(main.messageId),
        externalChatId: main.chatId,
        publicationKind: telegramKind,
        sentText: telegramText,
        photos: post.photos,
        payloadHash: post.payloadHash,
        lastError: null,
        publishedAt: deps.now ?? new Date(),
        deletedAt: null
      });
    }
  }

  for (const target of externalTargets()) {
    if (!post.publishTargets[target]) {
      continue;
    }

    const existing = await deps.db.findSocialPublication(post.id, target);
    if (existing?.status === "published") {
      continue;
    }

    const publisher = deps.externalPublishers?.[target];
    if (!publisher) {
      throw new Error(`${target.toUpperCase()} publisher is not configured`);
    }

    const text = target === "max" ? await fitForMaxText(sourceText) : await fitForVkPost(sourceText);
    const result = await publisher.publish({
      bitrixId: post.bitrixId,
      text,
      photos: post.photos,
      payloadHash: post.payloadHash
    });
    await deps.db.upsertSocialPublication(post.id, {
      target,
      status: "published",
      externalId: result.externalId,
      externalChatId: result.externalChatId ?? null,
      publicationKind: result.publicationKind,
      sentText: result.sentText,
      photos: result.photos,
      payloadHash: post.payloadHash,
      lastError: null,
      publishedAt: deps.now ?? new Date(),
      deletedAt: null
    });
  }

  return {
    telegramKind,
    telegramText,
    telegramMessages
  };
}

async function publishStoredPost(
  post: StoredBitrixPost,
  telegram: TelegramClient,
  sourceText: string,
  textFit?: TextFitOptions
): Promise<{
  kind: PublicationKind;
  telegramText: string;
  messages: TelegramMessageRef[];
}> {
  if (post.photos.length === 0) {
    const telegramText = await fitForTelegramText(sourceText, textFit);
    const message = await telegram.sendText({ text: telegramText });
    return {
      kind: "text",
      telegramText,
      messages: [message]
    };
  }

  const telegramText = await fitForTelegramCaption(sourceText, textFit);
  if (post.photos.length === 1) {
    const message = await telegram.sendPhoto({
      photo: post.photos[0],
      caption: telegramText
    });
    return {
      kind: "photo",
      telegramText,
      messages: [message]
    };
  }

  const messages = await telegram.sendMediaGroup({
    photos: post.photos,
    caption: telegramText
  });
  return {
    kind: "media_group",
    telegramText,
    messages
  };
}

function externalTargets(): ExternalSocialTarget[] {
  return ["vk", "max"];
}
