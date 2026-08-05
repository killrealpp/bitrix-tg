import {
  isSocialValueEmpty,
  type ParsedBitrixEvent
} from "../bitrix/parseWebhook";
import {
  getUnresolvedPhotoError,
  getUnresolvedPhotoIds,
  hasUnresolvedPhotos,
  type BitrixPhotoResolver
} from "../bitrix/photoResolver";
import type {
  DbGateway,
  PersistTelegramMessageInput,
  PublicationKind,
  StoredBitrixPost,
  StoredTelegramMessage
} from "../db/DbGateway";
import { buildTelegramSourceText } from "../text/buildText";
import {
  fitForTelegramCaption,
  fitForTelegramText,
  fitForMaxText,
  fitForVkPost,
  type TextFitOptions
} from "../text/fitText";
import { prepareSocialText } from "../text/socialText";
import type {
  PreparedSocialTexts,
  SocialTextPlatform
} from "../text/socialPlatforms";
import { redactSensitiveText } from "../security/redaction";
import type {
  ExternalSocialPublisher,
  ExternalSocialTarget
} from "../social/types";
import type {
  TelegramClient,
  TelegramMessageRef
} from "../telegram/client";

export type ProcessStatus =
  | "ignored"
  | "deleted"
  | "scheduled"
  | "published"
  | "edited"
  | "unchanged"
  | "failed";

export interface ProcessResult {
  status: ProcessStatus;
  bitrixId: number;
  reason?: string;
  messageIds?: number[];
  error?: string;
}

export type MediaSyncPolicy = "soft" | "rebuild";

export interface ProcessBitrixEventDeps {
  db: DbGateway;
  telegram: TelegramClient;
  externalPublishers?: Partial<Record<ExternalSocialTarget, ExternalSocialPublisher>>;
  textFit?: TextFitOptions;
  now?: Date;
  mediaSyncPolicy?: MediaSyncPolicy;
  adminNotifier?: MissingScheduleTimeAdminNotifier;
  photoResolver?: BitrixPhotoResolver;
  requireExactScheduleTime?: boolean;
}

export interface MissingScheduleTimeAdminNotifier {
  notifyMissingScheduleTime(input: {
    bitrixId: number;
    sourceField: string | null;
    rawValue: string | null;
    error: string;
  }): Promise<void>;
  notifyPhotoResolutionFailure?(input: {
    bitrixId: number;
    photoIds: string[];
    error: string;
  }): Promise<void>;
  notifySocialPublicationFailure?(input: {
    bitrixId: number;
    target: string;
    error: string;
    action: "publish" | "delete";
  }): Promise<void>;
}

export async function processBitrixEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps
): Promise<ProcessResult> {
  const now = deps.now ?? new Date();
  const rawSourceText = buildTelegramSourceText(event);
  const existing = await deps.db.findPostByBitrixId(event.bitrixId);

  if (!event.isActive) {
    try {
      return await handleDisabledEvent(event, deps, rawSourceText, existing, "inactive");
    } catch (error) {
      return markFailed(event, deps.db, existing, error);
    }
  }

  if (!event.publishSocial || isSocialValueEmpty(event.socialValue)) {
    try {
      return await handleDisabledEvent(
        event,
        deps,
        rawSourceText,
        existing,
        "empty_social_value"
      );
    } catch (error) {
      return markFailed(event, deps.db, existing, error);
    }
  }

  if (!hasAnyPublishTarget(event)) {
    try {
      return await handleDisabledEvent(
        event,
        deps,
        rawSourceText,
        existing,
        "empty_publish_targets"
      );
    } catch (error) {
      return markFailed(event, deps.db, existing, error);
    }
  }

  const missingExactTimeError = getMissingExactTimeError(
    event,
    deps.requireExactScheduleTime ?? false
  );
  if (missingExactTimeError) {
    return failMissingExactTime(
      event,
      deps,
      rawSourceText,
      existing,
      missingExactTimeError
    );
  }

  if (existing && (await isPublicationAlreadySatisfied(event, deps, existing))) {
    return {
      status: "unchanged",
      bitrixId: event.bitrixId,
      reason: "payload_hash_match"
    };
  }

  const resolvedEventResult = await resolveEventPhotos(
    event,
    deps,
    rawSourceText,
    existing
  );
  if ("status" in resolvedEventResult) {
    return resolvedEventResult;
  }

  const resolvedEvent = resolvedEventResult;
  const unresolvedPhotoError = getUnresolvedPhotoError(resolvedEvent.photos);
  if (unresolvedPhotoError) {
    return failUnresolvedPhotos(
      resolvedEvent,
      deps,
      rawSourceText,
      existing,
      unresolvedPhotoError
    );
  }

  const preparedTexts = await prepareSocialTexts(
    resolvedEvent,
    rawSourceText,
    deps.textFit
  );

  if (resolvedEvent.scheduledAt && resolvedEvent.scheduledAt.getTime() > now.getTime()) {
    await upsertScheduledPost(resolvedEvent, deps.db, rawSourceText, preparedTexts, existing);
    return {
      status: "scheduled",
      bitrixId: resolvedEvent.bitrixId,
      reason: "scheduled_at_in_future"
    };
  }

  try {
    return await publishOrSyncActiveEvent(
      resolvedEvent,
      deps,
      rawSourceText,
      preparedTexts,
      existing
    );
  } catch (error) {
    return markFailed(resolvedEvent, deps.db, existing, error);
  }
}

async function failMissingExactTime(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost | null,
  message: string
): Promise<ProcessResult> {
  let adminNotifiedAt =
    existing?.payloadHash === event.payloadHash ? existing.adminNotifiedAt : null;

  if (!adminNotifiedAt && deps.adminNotifier) {
    try {
      await deps.adminNotifier.notifyMissingScheduleTime({
        bitrixId: event.bitrixId,
        sourceField: event.scheduledAtSourceField,
        rawValue: event.scheduledAtRawValue,
        error: message
      });
      adminNotifiedAt = deps.now ?? new Date();
    } catch {
      adminNotifiedAt = null;
    }
  }

  const patch = {
    status: "failed" as const,
    scheduledAt: event.scheduledAt,
    sourceText,
    preparedText: sourceText,
    preparedTexts: rawPreparedTexts(sourceText),
    postType: event.postType,
    publishTargets: event.publishTargets,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: message,
    scheduledRetryCount: 0,
    adminNotifiedAt
  };

  if (existing) {
    await deps.db.updatePost(existing.id, patch);
  } else {
    await deps.db.createPost({
      bitrixId: event.bitrixId,
      ...patch
    });
  }

  return {
    status: "failed",
    bitrixId: event.bitrixId,
    error: message
  };
}

function getMissingExactTimeError(
  event: ParsedBitrixEvent,
  requireExactScheduleTime: boolean
): string | null {
  if (!event.scheduledAtSourceField) {
    return requireExactScheduleTime
      ? "Missing exact publication time. Set active_from with HH:MM:SS before publishing."
      : null;
  }

  if (event.scheduledAtPrecision === "datetime") {
    return null;
  }

  return [
    `Missing exact publication time in ${event.scheduledAtSourceField}`,
    `Received value: ${event.scheduledAtRawValue ?? "unknown"}`,
    "Set active_from with HH:MM:SS before publishing."
  ].join(". ");
}

function shouldPublishAsNew(existing: StoredBitrixPost | null): boolean {
  if (!existing) {
    return true;
  }

  if (existing.status === "published" && !hasTelegramReference(existing)) {
    return true;
  }

  if (existing.status === "ignored" || existing.status === "scheduled") {
    return true;
  }

  if (
    (existing.status === "failed" || existing.status === "publishing") &&
    !hasTelegramReference(existing)
  ) {
    return true;
  }

  return false;
}

function hasAnyPublishTarget(event: ParsedBitrixEvent): boolean {
  return event.publishTargets.telegram || event.publishTargets.max;
}

async function prepareSocialTexts(
  event: ParsedBitrixEvent,
  rawSourceText: string,
  textFit?: TextFitOptions
): Promise<PreparedSocialTexts> {
  const preparedTexts: PreparedSocialTexts = {};

  if (event.publishTargets.telegram) {
    preparedTexts.telegram = await prepareSocialText(
      event,
      rawSourceText,
      "telegram",
      textFit
    );
  }

  if (event.publishTargets.max) {
    preparedTexts.max = await prepareSocialText(event, rawSourceText, "max", textFit);
  }

  return preparedTexts;
}

function platformText(
  preparedTexts: PreparedSocialTexts,
  platform: SocialTextPlatform,
  fallback: string
): string {
  return preparedTexts[platform] ?? fallback;
}

function legacyPreparedText(preparedTexts: PreparedSocialTexts): string | null {
  return preparedTexts.telegram ?? preparedTexts.max ?? null;
}

function preparedTextPatch(preparedTexts: PreparedSocialTexts): {
  preparedText: string | null;
  preparedTexts: PreparedSocialTexts;
} {
  return {
    preparedText: legacyPreparedText(preparedTexts),
    preparedTexts
  };
}

function rawPreparedTexts(sourceText: string): PreparedSocialTexts {
  return {
    telegram: sourceText,
    max: sourceText
  };
}

function storedPlatformText(
  post: StoredBitrixPost,
  platform: SocialTextPlatform
): string | null {
  return post.preparedTexts[platform] ?? post.preparedText ?? null;
}

async function isPublicationAlreadySatisfied(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  existing: StoredBitrixPost
): Promise<boolean> {
  if (
    existing.payloadHash !== event.payloadHash ||
    (existing.status !== "published" && existing.status !== "scheduled")
  ) {
    return false;
  }

  if (existing.status === "scheduled") {
    return true;
  }

  if (event.publishTargets.telegram !== hasTelegramReference(existing)) {
    return false;
  }

  for (const target of externalTargets()) {
    const publication = await deps.db.findSocialPublication(existing.id, target);
    const isPublished = publication?.status === "published";
    if (event.publishTargets[target] !== isPublished) {
      return false;
    }
  }

  return true;
}

async function publishOrSyncActiveEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  rawSourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost | null
): Promise<ProcessResult> {
  let workingPost = existing;
  const touched: ProcessStatus[] = [];
  const messageIds: number[] = [];
  const telegramPreparedText = platformText(
    preparedTexts,
    "telegram",
    rawSourceText
  );

  if (event.publishTargets.telegram) {
    if (
      workingPost &&
      hasTelegramReference(workingPost) &&
      workingPost.status === "published" &&
      (storedPlatformText(workingPost, "telegram") ?? workingPost.sourceText) ===
        telegramPreparedText &&
      photosEqual(workingPost.photos, event.photos)
    ) {
      workingPost = await deps.db.updatePost(workingPost.id, {
        status: "published",
        scheduledAt: event.scheduledAt,
        sourceText: telegramPreparedText,
        ...preparedTextPatch(preparedTexts),
        postType: event.postType,
        publishTargets: event.publishTargets,
        photos: event.photos,
        payloadHash: event.payloadHash,
        lastError: null,
        scheduledRetryCount: 0,
        adminNotifiedAt: null
      });
      await recordTelegramPublication(deps.db, workingPost, event.payloadHash);
    } else if (!workingPost || shouldPublishAsNew(workingPost)) {
      const result = await publishNewEvent(
        event,
        deps,
        telegramPreparedText,
        preparedTexts,
        workingPost
      );
      touched.push(result.status);
      messageIds.push(...(result.messageIds ?? []));
      workingPost = await deps.db.findPostByBitrixId(event.bitrixId);
      if (workingPost) {
        await recordTelegramPublication(deps.db, workingPost, event.payloadHash);
      }
    } else {
      const result = await editExistingEvent(
        event,
        deps,
        telegramPreparedText,
        preparedTexts,
        workingPost
      );
      touched.push(result.status);
      messageIds.push(...(result.messageIds ?? []));
      workingPost = await deps.db.findPostByBitrixId(event.bitrixId);
      if (workingPost) {
        await recordTelegramPublication(deps.db, workingPost, event.payloadHash);
      }
    }
  } else {
    workingPost = await upsertPostWithoutTelegram(
      event,
      deps.db,
      rawSourceText,
      preparedTexts,
      workingPost
    );
    const deleted = await deleteTelegramTargetIfNeeded(event, deps, workingPost);
    if (deleted.length > 0) {
      touched.push("deleted");
      messageIds.push(...deleted);
      workingPost = await deps.db.findPostByBitrixId(event.bitrixId);
    }
  }

  if (!workingPost) {
    workingPost = await upsertPostWithoutTelegram(
      event,
      deps.db,
      rawSourceText,
      preparedTexts,
      null
    );
  }

  const externalResult = await syncExternalTargets(
    event,
    deps,
    workingPost,
    preparedTexts,
    rawSourceText
  );
  touched.push(...externalResult.statuses);

  const freshPost = await deps.db.findPostByBitrixId(event.bitrixId);
  if (freshPost) {
    await deps.db.updatePost(freshPost.id, {
      status: "published",
      scheduledAt: event.scheduledAt,
      sourceText: event.publishTargets.telegram ? telegramPreparedText : rawSourceText,
      ...preparedTextPatch(preparedTexts),
      postType: event.postType,
      publishTargets: event.publishTargets,
      photos: event.photos,
      payloadHash: event.payloadHash,
      lastError: null,
      scheduledRetryCount: 0,
      adminNotifiedAt: null
    });
  }

  const status = summarizeStatuses(touched);
  return {
    status,
    bitrixId: event.bitrixId,
    messageIds: messageIds.length > 0 ? messageIds : undefined,
    reason: status === "unchanged" ? "targets_already_satisfied" : undefined
  };
}

async function upsertPostWithoutTelegram(
  event: ParsedBitrixEvent,
  db: DbGateway,
  rawSourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost | null
): Promise<StoredBitrixPost> {
  const patch = {
    status: "publishing" as const,
    scheduledAt: event.scheduledAt,
    sourceText: rawSourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  };

  if (existing) {
    return db.updatePost(existing.id, patch);
  }

  return db.createPost({
    bitrixId: event.bitrixId,
    ...patch
  });
}

async function recordTelegramPublication(
  db: DbGateway,
  post: StoredBitrixPost,
  payloadHash: string
): Promise<void> {
  if (!post.chatId || !post.mainMessageId) {
    return;
  }

  await db.upsertSocialPublication(post.id, {
    target: "telegram",
    status: "published",
    externalId: String(post.mainMessageId),
    externalChatId: post.chatId,
    publicationKind: post.publicationKind,
    sentText: post.telegramText,
    photos: post.photos,
    payloadHash,
    lastError: null,
    publishedAt: new Date(),
    deletedAt: null
  });
}

async function syncExternalTargets(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  post: StoredBitrixPost,
  preparedTexts: PreparedSocialTexts,
  rawSourceText: string
): Promise<{ statuses: ProcessStatus[] }> {
  const statuses: ProcessStatus[] = [];
  const failures: string[] = [];

  for (const target of externalTargets()) {
    if (!event.publishTargets[target]) {
      const deleted = await deleteExternalTargetIfNeeded(event, deps, post, target);
      if (deleted) {
        statuses.push("deleted");
      }
      continue;
    }

    const existingPublication = await deps.db.findSocialPublication(post.id, target);
    if (existingPublication?.status === "published") {
      continue;
    }

    const publisher = deps.externalPublishers?.[target];
    if (!publisher) {
      const message = `${target.toUpperCase()} publisher is not configured`;
      await deps.db.upsertSocialPublication(post.id, {
        target,
        status: "failed",
        photos: event.photos,
        payloadHash: event.payloadHash,
        lastError: message
      });
      await notifySocialFailure(event, deps, target, message, "publish");
      failures.push(message);
      continue;
    }

    try {
      const targetPreparedText = platformText(
        preparedTexts,
        target as SocialTextPlatform,
        rawSourceText
      );
      const text =
        target === "max"
          ? await fitForMaxText(targetPreparedText)
          : await fitForVkPost(targetPreparedText);
      const result = await publisher.publish({
        bitrixId: event.bitrixId,
        text,
        photos: event.photos,
        payloadHash: event.payloadHash
      });
      await deps.db.upsertSocialPublication(post.id, {
        target,
        status: "published",
        externalId: result.externalId,
        externalChatId: result.externalChatId ?? null,
        publicationKind: result.publicationKind,
        sentText: result.sentText,
        photos: result.photos,
        payloadHash: event.payloadHash,
        lastError: null,
        publishedAt: deps.now ?? new Date(),
        deletedAt: null
      });
      statuses.push("published");
    } catch (error) {
      const message = redactErrorMessage(error);
      await deps.db.upsertSocialPublication(post.id, {
        target,
        status: "failed",
        photos: event.photos,
        payloadHash: event.payloadHash,
        lastError: message
      });
      await notifySocialFailure(event, deps, target, message, "publish");
      failures.push(`${target.toUpperCase()}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  return { statuses };
}

async function deleteTelegramTargetIfNeeded(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  existing: StoredBitrixPost
): Promise<number[]> {
  if (!hasTelegramReference(existing)) {
    return [];
  }

  const messagesToDelete = await listMessagesToDelete(deps.db, existing);
  const deletedMessageIds: number[] = [];
  for (const message of messagesToDelete) {
    await deps.telegram.deleteMessage({
      chatId: message.chatId,
      messageId: message.tgMessageId
    });
    deletedMessageIds.push(message.tgMessageId);
  }

  await deps.db.replaceTelegramMessages(existing.id, []);
  await deps.db.upsertSocialPublication(existing.id, {
    target: "telegram",
    status: "deleted",
    externalId: existing.mainMessageId ? String(existing.mainMessageId) : null,
    externalChatId: existing.chatId,
    publicationKind: existing.publicationKind,
    sentText: existing.telegramText,
    photos: existing.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    deletedAt: deps.now ?? new Date(),
    publishedAt: null
  });
  await deps.db.updatePost(existing.id, {
    chatId: null,
    mainMessageId: null,
    publicationKind: null,
    telegramText: null
  });

  return deletedMessageIds;
}

async function deleteExternalTargetIfNeeded(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  post: StoredBitrixPost,
  target: ExternalSocialTarget
): Promise<boolean> {
  const publication = await deps.db.findSocialPublication(post.id, target);
  if (publication?.status !== "published" || !publication.externalId) {
    return false;
  }

  const publisher = deps.externalPublishers?.[target];
  if (!publisher) {
    const message = `${target.toUpperCase()} publisher is not configured for delete`;
    await deps.db.upsertSocialPublication(post.id, {
      target,
      status: "failed",
      externalId: publication.externalId,
      externalChatId: publication.externalChatId,
      publicationKind: publication.publicationKind,
      sentText: publication.sentText,
      photos: publication.photos,
      payloadHash: event.payloadHash,
      lastError: message,
      publishedAt: publication.publishedAt,
      deletedAt: null
    });
    await notifySocialFailure(event, deps, target, message, "delete");
    throw new Error(message);
  }

  try {
    await publisher.delete({
      externalId: publication.externalId,
      externalChatId: publication.externalChatId
    });
    await deps.db.upsertSocialPublication(post.id, {
      target,
      status: "deleted",
      externalId: publication.externalId,
      externalChatId: publication.externalChatId,
      publicationKind: publication.publicationKind,
      sentText: publication.sentText,
      photos: publication.photos,
      payloadHash: event.payloadHash,
      lastError: null,
      publishedAt: publication.publishedAt,
      deletedAt: deps.now ?? new Date()
    });
    return true;
  } catch (error) {
    const message = redactErrorMessage(error);
    await deps.db.upsertSocialPublication(post.id, {
      target,
      status: "failed",
      externalId: publication.externalId,
      externalChatId: publication.externalChatId,
      publicationKind: publication.publicationKind,
      sentText: publication.sentText,
      photos: publication.photos,
      payloadHash: event.payloadHash,
      lastError: message,
      publishedAt: publication.publishedAt,
      deletedAt: null
    });
    await notifySocialFailure(event, deps, target, message, "delete");
    throw error;
  }
}

async function notifySocialFailure(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  target: string,
  error: string,
  action: "publish" | "delete"
): Promise<void> {
  try {
    await deps.adminNotifier?.notifySocialPublicationFailure?.({
      bitrixId: event.bitrixId,
      target,
      error,
      action
    });
  } catch {
    // Admin notification failure must not mask the original target error.
  }
}

function externalTargets(): ExternalSocialTarget[] {
  return ["max"];
}

function summarizeStatuses(statuses: ProcessStatus[]): ProcessStatus {
  if (statuses.includes("deleted")) {
    return "deleted";
  }

  if (statuses.includes("edited")) {
    return "edited";
  }

  if (statuses.includes("published")) {
    return "published";
  }

  return "unchanged";
}

async function resolveEventPhotos(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost | null
): Promise<ParsedBitrixEvent | ProcessResult> {
  if (!hasUnresolvedPhotos(event.photos) || !deps.photoResolver) {
    return event;
  }

  try {
    const photos = await deps.photoResolver.resolvePhotos(event.photos);
    return {
      ...event,
      photos
    };
  } catch (error) {
    return failUnresolvedPhotos(
      event,
      deps,
      sourceText,
      existing,
      redactErrorMessage(error)
    );
  }
}

function redactErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function hasTelegramReference(post: StoredBitrixPost): boolean {
  return Boolean(post.chatId && post.mainMessageId);
}

async function markFailed(
  event: ParsedBitrixEvent,
  db: DbGateway,
  existing: StoredBitrixPost | null,
  error: unknown
): Promise<ProcessResult> {
  const message = redactErrorMessage(error);
  const postToMarkFailed =
    existing ?? (await db.findPostByBitrixId(event.bitrixId));

  if (postToMarkFailed) {
    await db.updatePost(postToMarkFailed.id, {
      status: "failed",
      lastError: message,
      payloadHash: event.payloadHash
    });
  }

  return {
    status: "failed",
    bitrixId: event.bitrixId,
    error: message
  };
}

async function failUnresolvedPhotos(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost | null,
  message: string
): Promise<ProcessResult> {
  let adminNotifiedAt =
    existing?.payloadHash === event.payloadHash && existing.lastError === message
      ? existing.adminNotifiedAt
      : null;

  if (!adminNotifiedAt && deps.adminNotifier?.notifyPhotoResolutionFailure) {
    try {
      await deps.adminNotifier.notifyPhotoResolutionFailure({
        bitrixId: event.bitrixId,
        photoIds: getUnresolvedPhotoIds(event.photos),
        error: message
      });
      adminNotifiedAt = deps.now ?? new Date();
    } catch {
      adminNotifiedAt = null;
    }
  }

  const patch = {
    status: "failed" as const,
    scheduledAt: event.scheduledAt,
    sourceText,
    preparedText: sourceText,
    preparedTexts: rawPreparedTexts(sourceText),
    postType: event.postType,
    publishTargets: event.publishTargets,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: message,
    scheduledRetryCount: 0,
    adminNotifiedAt
  };

  if (existing) {
    await deps.db.updatePost(existing.id, patch);
  } else {
    await deps.db.createPost({
      bitrixId: event.bitrixId,
      ...patch
    });
  }

  return {
    status: "failed",
    bitrixId: event.bitrixId,
    error: message
  };
}

async function upsertScheduledPost(
  event: ParsedBitrixEvent,
  db: DbGateway,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost | null
): Promise<void> {
  const patch = {
    status: "scheduled" as const,
    scheduledAt: event.scheduledAt,
    sourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  };

  if (existing) {
    await db.updatePost(existing.id, patch);
    return;
  }

  await db.createPost({
    bitrixId: event.bitrixId,
    ...patch
  });
}

async function publishNewEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost | null
): Promise<ProcessResult> {
  const post =
    existing ??
    (await deps.db.createPost({
      bitrixId: event.bitrixId,
      status: "publishing",
      sourceText,
      ...preparedTextPatch(preparedTexts),
      postType: event.postType,
      publishTargets: event.publishTargets,
      photos: event.photos,
      payloadHash: event.payloadHash
    }));

  if (existing) {
    await deps.db.updatePost(existing.id, {
      status: "publishing",
      sourceText,
      ...preparedTextPatch(preparedTexts),
      postType: event.postType,
      publishTargets: event.publishTargets,
      photos: event.photos,
      payloadHash: event.payloadHash,
      lastError: null,
      scheduledRetryCount: 0,
      adminNotifiedAt: null
    });
  }

  const published = await publishByPhotoCount(event, deps.telegram, sourceText, deps.textFit);
  const main = published.messages[0];

  await deps.db.updatePost(post.id, {
    status: "published",
    chatId: main?.chatId ?? null,
    mainMessageId: main?.messageId ?? null,
    publicationKind: published.kind,
    scheduledAt: event.scheduledAt,
    sourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    telegramText: published.telegramText,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });
  await deps.db.replaceTelegramMessages(post.id, published.messages.map(toPersistedMessage));

  return {
    status: "published",
    bitrixId: event.bitrixId,
    messageIds: published.messages.map((message) => message.messageId)
  };
}

async function editExistingEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  if (existing.publicationKind === "text" && event.photos.length === 0) {
    if (!existing.chatId || !existing.mainMessageId) {
      throw new Error("Existing text post has no Telegram message reference");
    }

    const telegramText = await fitForTelegramText(sourceText, deps.textFit);
    const edited = await deps.telegram.editText({
      chatId: existing.chatId,
      messageId: existing.mainMessageId,
      text: telegramText
    });

    await deps.db.updatePost(existing.id, {
      status: "published",
      sourceText,
      ...preparedTextPatch(preparedTexts),
      postType: event.postType,
      publishTargets: event.publishTargets,
      telegramText,
      photos: event.photos,
      payloadHash: event.payloadHash,
      lastError: null,
      scheduledRetryCount: 0,
      adminNotifiedAt: null
    });

    return {
      status: "edited",
      bitrixId: event.bitrixId,
      messageIds: [edited.messageId]
    };
  }

  if (existing.publicationKind === "text" && event.photos.length > 0) {
    const mediaSyncPolicy = deps.mediaSyncPolicy ?? "rebuild";
    if (mediaSyncPolicy === "rebuild") {
      return rebuildExistingEvent(event, deps, sourceText, preparedTexts, existing);
    }

    const extraMessages = await publishExtraPhotos(event.photos, deps.telegram);
    await deps.db.appendTelegramMessages(
      existing.id,
      extraMessages.map(toPersistedMessage)
    );
    await deps.db.updatePost(existing.id, {
      status: "published",
      publicationKind: "mixed",
      sourceText,
      ...preparedTextPatch(preparedTexts),
      postType: event.postType,
      publishTargets: event.publishTargets,
      photos: event.photos,
      payloadHash: event.payloadHash,
      lastError: null,
      scheduledRetryCount: 0,
      adminNotifiedAt: null
    });

    return {
      status: "edited",
      bitrixId: event.bitrixId,
      messageIds: extraMessages.map((message) => message.messageId)
    };
  }

  if (existing.publicationKind === "mixed") {
    return editMixedEvent(event, deps, sourceText, preparedTexts, existing);
  }

  if (existing.publicationKind === "photo" || existing.publicationKind === "media_group") {
    return editMediaEvent(event, deps, sourceText, preparedTexts, existing);
  }

  throw new Error(`Unsupported edit path for publication kind ${existing.publicationKind}`);
}

async function editMixedEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  if (!existing.chatId || !existing.mainMessageId) {
    throw new Error("Existing mixed post has no Telegram text message reference");
  }

  const storedMessages = await deps.db.listTelegramMessages(existing.id);
  const textMessages = storedMessages.filter((message) => message.role === "text");
  const extraMessages = storedMessages.filter((message) => message.role !== "text");
  const mediaSyncPolicy = deps.mediaSyncPolicy ?? "rebuild";
  const photosChanged = !photosEqual(existing.photos, event.photos);
  if (photosChanged && mediaSyncPolicy === "rebuild") {
    return rebuildExistingEvent(event, deps, sourceText, preparedTexts, existing);
  }

  const telegramText = await fitForTelegramText(sourceText, deps.textFit);
  const editedMessageIds: number[] = [];

  if (sourceText !== existing.sourceText || telegramText !== existing.telegramText) {
    const editedText = await deps.telegram.editText({
      chatId: existing.chatId,
      messageId: existing.mainMessageId,
      text: telegramText
    });
    editedMessageIds.push(editedText.messageId);
  }

  const syncedPhotos =
    await syncExtraPhotosSoft(event.photos, deps.telegram, extraMessages);

  if (mediaSyncPolicy === "rebuild" || syncedPhotos.replaceExisting) {
    await deps.db.replaceTelegramMessages(existing.id, [
      ...textMessages.map(storedMessageToPersisted),
      ...syncedPhotos.retainedMessages.map(storedMessageToPersisted),
      ...syncedPhotos.messages.map(toPersistedMessage)
    ]);
  } else if (syncedPhotos.messages.length > 0) {
    await deps.db.appendTelegramMessages(
      existing.id,
      syncedPhotos.messages.map(toPersistedMessage)
    );
  }

  await deps.db.updatePost(existing.id, {
    status: "published",
    publicationKind:
      syncedPhotos.retainedMessages.length > 0 || syncedPhotos.messages.length > 0
        ? "mixed"
        : "text",
    sourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    telegramText,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });

  return {
    status: "edited",
    bitrixId: event.bitrixId,
    messageIds: [...editedMessageIds, ...syncedPhotos.messageIds]
  };
}

async function editMediaEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  if (!existing.chatId || !existing.mainMessageId) {
    throw new Error("Existing media post has no Telegram message reference");
  }

  const photosChanged = !photosEqual(existing.photos, event.photos);
  const mediaSyncPolicy = deps.mediaSyncPolicy ?? "rebuild";
  if (mediaSyncPolicy === "rebuild" && photosChanged) {
    return rebuildExistingEvent(event, deps, sourceText, preparedTexts, existing);
  }

  const telegramText = await fitForTelegramCaption(sourceText, deps.textFit);
  const captionChanged =
    sourceText !== existing.sourceText || telegramText !== existing.telegramText;
  const storedMessages = await deps.db.listTelegramMessages(existing.id);
  const mediaMessages = storedMessages
    .filter((message) => message.role !== "text")
    .sort(compareStoredMediaMessages);
  const editedMessageIds: number[] = [];
  const appendedMessages: TelegramMessageRef[] = [];
  const retainedMessages = [...storedMessages];

  if (event.photos.length === 0 && captionChanged) {
    const edited = await deps.telegram.editCaption({
      chatId: existing.chatId,
      messageId: existing.mainMessageId,
      caption: telegramText
    });
    editedMessageIds.push(edited.messageId);
  } else {
    for (let index = 0; index < Math.min(mediaMessages.length, event.photos.length); index += 1) {
      const storedMessage = mediaMessages[index];
      const nextPhoto = event.photos[index];

      if (storedMessage.mediaUrl !== nextPhoto.url) {
        const edited = await deps.telegram.editMedia({
          chatId: storedMessage.chatId,
          messageId: storedMessage.tgMessageId,
          photo: nextPhoto,
          caption: index === 0 ? telegramText : undefined,
          role: storedMessage.role,
          mediaIndex: storedMessage.mediaIndex ?? index
        });
        editedMessageIds.push(edited.messageId);
        updateRetainedMedia(retainedMessages, storedMessage, edited);
      } else if (index === 0 && captionChanged) {
        const edited = await deps.telegram.editCaption({
          chatId: storedMessage.chatId,
          messageId: storedMessage.tgMessageId,
          caption: telegramText
        });
        editedMessageIds.push(edited.messageId);
      }
    }

    const addedPhotos = event.photos.slice(mediaMessages.length);
    if (addedPhotos.length > 0) {
      const added = await publishExtraPhotos(addedPhotos, deps.telegram);
      appendedMessages.push(...added);
    }
  }

  await deps.db.replaceTelegramMessages(existing.id, [
    ...retainedMessages.map(storedMessageToPersisted),
    ...appendedMessages.map(toPersistedMessage)
  ]);
  await deps.db.updatePost(existing.id, {
    status: "published",
    sourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    telegramText,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });

  return {
    status: "edited",
    bitrixId: event.bitrixId,
    messageIds: [
      ...editedMessageIds,
      ...appendedMessages.map((message) => message.messageId)
    ]
  };
}

async function rebuildExistingEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  preparedTexts: PreparedSocialTexts,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  const messagesToDelete = await listMessagesToDelete(deps.db, existing);
  for (const message of messagesToDelete) {
    await deps.telegram.deleteMessage({
      chatId: message.chatId,
      messageId: message.tgMessageId
    });
  }

  const published = await publishByPhotoCount(event, deps.telegram, sourceText, deps.textFit);
  const main = published.messages[0];
  await deps.db.updatePost(existing.id, {
    status: "published",
    chatId: main?.chatId ?? null,
    mainMessageId: main?.messageId ?? null,
    publicationKind: published.kind,
    sourceText,
    ...preparedTextPatch(preparedTexts),
    postType: event.postType,
    publishTargets: event.publishTargets,
    telegramText: published.telegramText,
    photos: event.photos,
    payloadHash: event.payloadHash,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });
  await deps.db.replaceTelegramMessages(
    existing.id,
    published.messages.map(toPersistedMessage)
  );

  return {
    status: "edited",
    bitrixId: event.bitrixId,
    messageIds: published.messages.map((message) => message.messageId)
  };
}

async function listMessagesToDelete(
  db: DbGateway,
  existing: StoredBitrixPost
): Promise<Array<Pick<StoredTelegramMessage, "chatId" | "tgMessageId">>> {
  const storedMessages = await db.listTelegramMessages(existing.id);
  if (storedMessages.length > 0) {
    return storedMessages;
  }

  if (!existing.chatId || !existing.mainMessageId) {
    return [];
  }

  return [
    {
      chatId: existing.chatId,
      tgMessageId: existing.mainMessageId
    }
  ];
}

async function publishByPhotoCount(
  event: ParsedBitrixEvent,
  telegram: TelegramClient,
  sourceText: string,
  textFit?: TextFitOptions
): Promise<{
  kind: PublicationKind;
  telegramText: string;
  messages: TelegramMessageRef[];
}> {
  if (event.photos.length === 0) {
    const telegramText = await fitForTelegramText(sourceText, textFit);
    const message = await telegram.sendText({ text: telegramText });
    return {
      kind: "text",
      telegramText,
      messages: [message]
    };
  }

  const telegramText = await fitForTelegramCaption(sourceText, textFit);
  if (event.photos.length === 1) {
    const message = await telegram.sendPhoto({
      photo: event.photos[0],
      caption: telegramText
    });
    return {
      kind: "photo",
      telegramText,
      messages: [message]
    };
  }

  const messages = await telegram.sendMediaGroup({
    photos: event.photos,
    caption: telegramText
  });
  return {
    kind: "media_group",
    telegramText,
    messages
  };
}

async function publishExtraPhotos(
  photos: ParsedBitrixEvent["photos"],
  telegram: TelegramClient
): Promise<TelegramMessageRef[]> {
  if (photos.length === 0) {
    return [];
  }

  if (photos.length === 1) {
    return [
      await telegram.sendPhoto({
        photo: photos[0],
        role: "extra_photo"
      })
    ];
  }

  return telegram.sendMediaGroup({
    photos,
    role: "extra_photo"
  });
}

interface PhotoSyncResult {
  messages: TelegramMessageRef[];
  messageIds: number[];
  retainedMessages: StoredTelegramMessage[];
  replaceExisting: boolean;
}

async function syncExtraPhotosSoft(
  photos: ParsedBitrixEvent["photos"],
  telegram: TelegramClient,
  existingMessages: StoredTelegramMessage[]
): Promise<PhotoSyncResult> {
  const retainedMessages = [...existingMessages].sort(compareStoredMediaMessages);
  const messageIds: number[] = [];
  let replaceExisting = false;

  for (let index = 0; index < Math.min(retainedMessages.length, photos.length); index += 1) {
    const storedMessage = retainedMessages[index];
    const nextPhoto = photos[index];
    if (storedMessage.mediaUrl === nextPhoto.url) {
      continue;
    }

    const edited = await telegram.editMedia({
      chatId: storedMessage.chatId,
      messageId: storedMessage.tgMessageId,
      photo: nextPhoto,
      role: storedMessage.role,
      mediaIndex: storedMessage.mediaIndex ?? index
    });
    updateRetainedMedia(retainedMessages, storedMessage, edited);
    messageIds.push(edited.messageId);
    replaceExisting = true;
  }

  const messages = await publishExtraPhotos(photos.slice(retainedMessages.length), telegram);

  return {
    messages,
    messageIds: [...messageIds, ...messages.map((message) => message.messageId)],
    retainedMessages,
    replaceExisting
  };
}

function toPersistedMessage(message: TelegramMessageRef): PersistTelegramMessageInput {
  return {
    chatId: message.chatId,
    tgMessageId: message.messageId,
    role: message.role,
    mediaIndex: message.mediaIndex ?? null,
    mediaUrl: message.mediaUrl ?? null,
    telegramFileId: message.telegramFileId ?? null
  };
}

function storedMessageToPersisted(
  message: StoredTelegramMessage
): PersistTelegramMessageInput {
  return {
    chatId: message.chatId,
    tgMessageId: message.tgMessageId,
    role: message.role,
    mediaIndex: message.mediaIndex,
    mediaUrl: message.mediaUrl,
    telegramFileId: message.telegramFileId
  };
}

function updateRetainedMedia(
  retainedMessages: StoredTelegramMessage[],
  storedMessage: StoredTelegramMessage,
  edited: TelegramMessageRef
): void {
  const index = retainedMessages.findIndex((message) => message.id === storedMessage.id);
  if (index === -1) {
    return;
  }

  retainedMessages[index] = {
    ...retainedMessages[index],
    role: edited.role,
    mediaIndex: edited.mediaIndex ?? retainedMessages[index].mediaIndex,
    mediaUrl: edited.mediaUrl ?? retainedMessages[index].mediaUrl,
    telegramFileId: edited.telegramFileId ?? retainedMessages[index].telegramFileId
  };
}

function photosEqual(
  first: ParsedBitrixEvent["photos"],
  second: ParsedBitrixEvent["photos"]
): boolean {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((photo, index) => photoKey(photo) === photoKey(second[index]));
}

function photoKey(photo: ParsedBitrixEvent["photos"][number]): string {
  return JSON.stringify({
    id: photo.id ?? null,
    path: photo.path ?? null,
    unresolved: photo.unresolved ?? false,
    url: photo.url ?? null
  });
}

function compareStoredMediaMessages(
  first: StoredTelegramMessage,
  second: StoredTelegramMessage
): number {
  return (first.mediaIndex ?? first.id) - (second.mediaIndex ?? second.id);
}

async function ignoreEvent(
  event: ParsedBitrixEvent,
  db: DbGateway,
  sourceText: string,
  existing: StoredBitrixPost | null,
  reason: string
): Promise<ProcessResult> {
  const hasTelegramMessages = Boolean(existing?.chatId || existing?.mainMessageId);

  if (existing && !hasTelegramMessages && existing.status !== "published") {
    if (existing.status !== "ignored" || existing.payloadHash !== event.payloadHash) {
      await db.updatePost(existing.id, {
        status: "ignored",
        scheduledAt: null,
        sourceText,
        preparedText: sourceText,
        preparedTexts: rawPreparedTexts(sourceText),
        postType: event.postType,
        publishTargets: event.publishTargets,
        photos: event.photos,
        payloadHash: event.payloadHash,
        lastError: null,
        scheduledRetryCount: 0,
        adminNotifiedAt: null
      });
    }
  }

  return ignored(event, reason);
}

async function handleDisabledEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost | null,
  reason: string
): Promise<ProcessResult> {
  if (!existing) {
    return ignoreEvent(event, deps.db, sourceText, existing, reason);
  }

  const deletedMessageIds: number[] = [];
  if (hasTelegramReference(existing)) {
    deletedMessageIds.push(...(await deleteTelegramTargetIfNeeded(event, deps, existing)));
  }

  for (const target of externalTargets()) {
    await deleteExternalTargetIfNeeded(event, deps, existing, target);
  }

  const deletedSomething =
    deletedMessageIds.length > 0 ||
    (await deps.db.listSocialPublications(existing.id)).some(
      (publication) => publication.status === "deleted"
    );

  await deps.db.updatePost(existing.id, {
    status: "ignored",
    chatId: null,
    mainMessageId: null,
    publicationKind: null,
    scheduledAt: null,
    sourceText,
    preparedText: sourceText,
    preparedTexts: rawPreparedTexts(sourceText),
    postType: event.postType,
    publishTargets: {
      telegram: false,
      vk: false,
      max: false
    },
    photos: event.photos,
    payloadHash: event.payloadHash,
    telegramText: null,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });

  if (!deletedSomething) {
    return ignored(event, reason);
  }

  return {
    status: "deleted",
    bitrixId: event.bitrixId,
    reason,
    messageIds: deletedMessageIds
  };
}

function ignored(event: ParsedBitrixEvent, reason: string): ProcessResult {
  return {
    status: "ignored",
    bitrixId: event.bitrixId,
    reason
  };
}
