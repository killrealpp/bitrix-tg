import {
  getUnresolvedPhotoError,
  hasUnresolvedPhotos,
  type BitrixPhotoResolver
} from "../bitrix/photoResolver";
import type {
  DbGateway,
  PublicationKind,
  StoredBitrixPost,
  StoredSocialPublication,
  StoredTelegramMessage
} from "../db/DbGateway";
import {
  fitForMaxText,
  fitForTelegramCaption,
  fitForTelegramText,
  fitForVkPost,
  type TextFitOptions
} from "../text/fitText";
import { sanitizeSocialPostText } from "../text/socialFooter";
import type { SocialTextPlatform } from "../text/socialPlatforms";
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
  onPostFailure?: (failure: ScheduledPostFailureEvent) => void | Promise<void>;
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

export interface ScheduledPostFailureEvent {
  bitrixId: number;
  error: string;
  retryCount: number;
  willRetry: boolean;
  nextRetryAt: Date | null;
  publishTargets: StoredBitrixPost["publishTargets"];
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
        const nextRetryAt = new Date(now.getTime() + retryDelayMs);
        const nextRetryCount = post.scheduledRetryCount + 1;
        await deps.db.updatePost(post.id, {
          status: "scheduled",
          scheduledAt: nextRetryAt,
          lastError: message,
          scheduledRetryCount: nextRetryCount,
          adminNotifiedAt: null
        });
        await notifyScheduledPostFailure(deps, {
          bitrixId: post.bitrixId,
          error: message,
          retryCount: nextRetryCount,
          willRetry: true,
          nextRetryAt,
          publishTargets: post.publishTargets
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
      await notifyScheduledPostFailure(deps, {
        bitrixId: post.bitrixId,
        error: message,
        retryCount: post.scheduledRetryCount,
        willRetry: false,
        nextRetryAt: null,
        publishTargets: post.publishTargets
      });
    }
  }

  return {
    checked: posts.length,
    published,
    failed
  };
}

async function notifyScheduledPostFailure(
  deps: RunDuePostsDeps,
  failure: ScheduledPostFailureEvent
): Promise<void> {
  if (!deps.onPostFailure) {
    return;
  }

  try {
    await deps.onPostFailure(failure);
  } catch {
    // Diagnostic logging hooks must not mask scheduled publication state updates.
  }
}

function redactErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function storedPlatformText(
  post: StoredBitrixPost,
  platform: SocialTextPlatform
): string | null {
  const text = post.preparedTexts[platform] ?? post.preparedText ?? null;
  return text ? sanitizeSocialPostText(text, platform) : null;
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
  const telegramSourceText =
    storedPlatformText(post, "telegram") ?? post.sourceText;
  const maxSourceText = storedPlatformText(post, "max") ?? post.sourceText;
  let telegramKind: PublicationKind | null = null;
  let telegramText: string | null = null;
  let telegramMessages: TelegramMessageRef[] = [];

  if (post.publishTargets.telegram) {
    const result = await publishOrReuseStoredTelegram(
      post,
      deps,
      telegramSourceText
    );
    telegramKind = result.telegramKind;
    telegramText = result.telegramText;
    telegramMessages = result.telegramMessages;
  }

  const failures: string[] = [];
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
      const message = `${target.toUpperCase()} publisher is not configured`;
      await recordScheduledExternalFailure(post, deps, target, message);
      failures.push(message);
      continue;
    }

    try {
      const text =
        target === "max"
          ? await fitForMaxText(maxSourceText)
          : await fitForVkPost(maxSourceText);
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
    } catch (error) {
      const message = redactErrorMessage(error);
      await recordScheduledExternalFailure(post, deps, target, message);
      failures.push(`${target.toUpperCase()}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  return {
    telegramKind,
    telegramText,
    telegramMessages
  };
}

async function publishOrReuseStoredTelegram(
  post: StoredBitrixPost,
  deps: RunDuePostsDeps,
  sourceText: string
): Promise<{
  telegramKind: PublicationKind | null;
  telegramText: string | null;
  telegramMessages: TelegramMessageRef[];
}> {
  const existing = await deps.db.findSocialPublication(post.id, "telegram");
  if (existing?.status === "published" && existing.externalId && existing.externalChatId) {
    const messages = await deps.db.listTelegramMessages(post.id);
    const telegramMessages =
      messages.length > 0
        ? messages.map(toTelegramMessageRef)
        : [telegramMessageFromPublication(existing)];

    return {
      telegramKind: existing.publicationKind ?? post.publicationKind,
      telegramText: existing.sentText ?? post.telegramText,
      telegramMessages
    };
  }

  const result = await publishStoredPost(
    post,
    deps.telegram,
    sourceText,
    storedPlatformText(post, "telegram") ? undefined : deps.textFit
  );
  const main = result.messages[0];
  if (main) {
    await deps.db.upsertSocialPublication(post.id, {
      target: "telegram",
      status: "published",
      externalId: String(main.messageId),
      externalChatId: main.chatId,
      publicationKind: result.kind,
      sentText: result.telegramText,
      photos: post.photos,
      payloadHash: post.payloadHash,
      lastError: null,
      publishedAt: deps.now ?? new Date(),
      deletedAt: null
    });
    await deps.db.updatePost(post.id, {
      chatId: main.chatId,
      mainMessageId: main.messageId,
      publicationKind: result.kind,
      telegramText: result.telegramText,
      photos: post.photos,
      lastError: null,
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
  }

  return {
    telegramKind: result.kind,
    telegramText: result.telegramText,
    telegramMessages: result.messages
  };
}

function toTelegramMessageRef(message: StoredTelegramMessage): TelegramMessageRef {
  return {
    chatId: message.chatId,
    messageId: message.tgMessageId,
    role: message.role,
    mediaIndex: message.mediaIndex ?? undefined,
    mediaUrl: message.mediaUrl ?? undefined,
    telegramFileId: message.telegramFileId ?? undefined
  };
}

function telegramMessageFromPublication(
  publication: StoredSocialPublication
): TelegramMessageRef {
  return {
    chatId: publication.externalChatId ?? "",
    messageId: Number(publication.externalId),
    role: telegramRoleForPublicationKind(publication.publicationKind),
    mediaIndex: publication.publicationKind === "media_group" ? 0 : undefined,
    mediaUrl: publication.photos[0]?.url
  };
}

function telegramRoleForPublicationKind(
  publicationKind: PublicationKind | null
): TelegramMessageRef["role"] {
  if (publicationKind === "photo") {
    return "photo";
  }

  if (publicationKind === "media_group") {
    return "album_item";
  }

  return "text";
}

async function recordScheduledExternalFailure(
  post: StoredBitrixPost,
  deps: RunDuePostsDeps,
  target: ExternalSocialTarget,
  message: string
): Promise<void> {
  await deps.db.upsertSocialPublication(post.id, {
    target,
    status: "failed",
    photos: post.photos,
    payloadHash: post.payloadHash,
    lastError: message,
    publishedAt: null,
    deletedAt: null
  });
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
  return ["max"];
}
