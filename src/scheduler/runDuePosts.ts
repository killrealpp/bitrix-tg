import {
  getUnresolvedPhotoError,
  hasUnresolvedPhotos,
  type BitrixPhotoResolver
} from "../bitrix/photoResolver";
import type { DbGateway, PublicationKind, StoredBitrixPost } from "../db/DbGateway";
import {
  fitForTelegramCaption,
  fitForTelegramText,
  type TextFitOptions
} from "../text/fitText";
import { redactSensitiveText } from "../security/redaction";
import type { TelegramClient, TelegramMessageRef } from "../telegram/client";

export interface RunDuePostsDeps {
  db: DbGateway;
  telegram: TelegramClient;
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
      const result = await publishStoredPost(
        resolvedPost,
        deps.telegram,
        deps.textFit
      );
      const main = result.messages[0];
      await deps.db.updatePost(post.id, {
        status: "published",
        chatId: main?.chatId ?? null,
        mainMessageId: main?.messageId ?? null,
        publicationKind: result.kind,
        telegramText: result.telegramText,
        photos: resolvedPost.photos,
        lastError: null,
        scheduledRetryCount: 0,
        adminNotifiedAt: null
      });
      await deps.db.replaceTelegramMessages(
        post.id,
        result.messages.map((message) => ({
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

async function publishStoredPost(
  post: StoredBitrixPost,
  telegram: TelegramClient,
  textFit?: TextFitOptions
): Promise<{
  kind: PublicationKind;
  telegramText: string;
  messages: TelegramMessageRef[];
}> {
  if (post.photos.length === 0) {
    const telegramText = await fitForTelegramText(post.sourceText, textFit);
    const message = await telegram.sendText({ text: telegramText });
    return {
      kind: "text",
      telegramText,
      messages: [message]
    };
  }

  const telegramText = await fitForTelegramCaption(post.sourceText, textFit);
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
