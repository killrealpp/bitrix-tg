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
  type TextFitOptions
} from "../text/fitText";
import { redactSensitiveText } from "../security/redaction";
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
}

export async function processBitrixEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps
): Promise<ProcessResult> {
  const now = deps.now ?? new Date();
  const sourceText = buildTelegramSourceText(event);
  const existing = await deps.db.findPostByBitrixId(event.bitrixId);

  if (!event.isActive) {
    try {
      return await handleInactiveEvent(event, deps, sourceText, existing);
    } catch (error) {
      return markFailed(event, deps.db, existing, error);
    }
  }

  if (isSocialValueEmpty(event.socialValue)) {
    return ignoreEvent(
      event,
      deps.db,
      sourceText,
      existing,
      "empty_social_value"
    );
  }

  const missingExactTimeError = getMissingExactTimeError(
    event,
    deps.requireExactScheduleTime ?? false
  );
  if (missingExactTimeError) {
    return failMissingExactTime(
      event,
      deps,
      sourceText,
      existing,
      missingExactTimeError
    );
  }

  if (
    existing &&
    existing.payloadHash === event.payloadHash &&
    (existing.status === "published" || existing.status === "scheduled")
  ) {
    return {
      status: "unchanged",
      bitrixId: event.bitrixId,
      reason: "payload_hash_match"
    };
  }

  const resolvedEventResult = await resolveEventPhotos(
    event,
    deps,
    sourceText,
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
      sourceText,
      existing,
      unresolvedPhotoError
    );
  }

  if (resolvedEvent.scheduledAt && resolvedEvent.scheduledAt.getTime() > now.getTime()) {
    await upsertScheduledPost(resolvedEvent, deps.db, sourceText, existing);
    return {
      status: "scheduled",
      bitrixId: resolvedEvent.bitrixId,
      reason: "scheduled_at_in_future"
    };
  }

  try {
    if (!existing) {
      return await publishNewEvent(resolvedEvent, deps, sourceText, existing);
    }

    if (shouldPublishAsNew(existing)) {
      return await publishNewEvent(resolvedEvent, deps, sourceText, existing);
    }

    return await editExistingEvent(resolvedEvent, deps, sourceText, existing);
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
  existing: StoredBitrixPost | null
): Promise<void> {
  const patch = {
    status: "scheduled" as const,
    scheduledAt: event.scheduledAt,
    sourceText,
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
  existing: StoredBitrixPost | null
): Promise<ProcessResult> {
  const post =
    existing ??
    (await deps.db.createPost({
      bitrixId: event.bitrixId,
      status: "publishing",
      sourceText,
      photos: event.photos,
      payloadHash: event.payloadHash
    }));

  if (existing) {
    await deps.db.updatePost(existing.id, {
      status: "publishing",
      sourceText,
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
    const extraMessages = await publishExtraPhotos(event.photos, deps.telegram);
    await deps.db.appendTelegramMessages(
      existing.id,
      extraMessages.map(toPersistedMessage)
    );
    await deps.db.updatePost(existing.id, {
      status: "published",
      publicationKind: "mixed",
      sourceText,
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
    return editMixedEvent(event, deps, sourceText, existing);
  }

  if (existing.publicationKind === "photo" || existing.publicationKind === "media_group") {
    return editMediaEvent(event, deps, sourceText, existing);
  }

  throw new Error(`Unsupported edit path for publication kind ${existing.publicationKind}`);
}

async function editMixedEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  if (!existing.chatId || !existing.mainMessageId) {
    throw new Error("Existing mixed post has no Telegram text message reference");
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

  const storedMessages = await deps.db.listTelegramMessages(existing.id);
  const textMessages = storedMessages.filter((message) => message.role === "text");
  const extraMessages = storedMessages.filter((message) => message.role !== "text");
  const mediaSyncPolicy = deps.mediaSyncPolicy ?? "rebuild";
  const photosChanged = !photosEqual(existing.photos, event.photos);
  const syncedPhotos =
    photosChanged && mediaSyncPolicy === "rebuild"
      ? await rebuildExtraPhotos(event.photos, deps.telegram, extraMessages)
      : await syncExtraPhotosSoft(event.photos, deps.telegram, extraMessages);

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
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  if (!existing.chatId || !existing.mainMessageId) {
    throw new Error("Existing media post has no Telegram message reference");
  }

  const photosChanged = !photosEqual(existing.photos, event.photos);
  const mediaSyncPolicy = deps.mediaSyncPolicy ?? "rebuild";
  if (mediaSyncPolicy === "rebuild" && photosChanged) {
    return rebuildMediaEvent(event, deps, sourceText, existing);
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

async function rebuildMediaEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost
): Promise<ProcessResult> {
  const storedMessages = await deps.db.listTelegramMessages(existing.id);
  for (const message of storedMessages) {
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

async function rebuildExtraPhotos(
  photos: ParsedBitrixEvent["photos"],
  telegram: TelegramClient,
  existingMessages: StoredTelegramMessage[]
): Promise<PhotoSyncResult> {
  for (const message of existingMessages) {
    await telegram.deleteMessage({
      chatId: message.chatId,
      messageId: message.tgMessageId
    });
  }

  const messages = await publishExtraPhotos(photos, telegram);

  return {
    messages,
    messageIds: messages.map((message) => message.messageId),
    retainedMessages: [],
    replaceExisting: true
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

async function handleInactiveEvent(
  event: ParsedBitrixEvent,
  deps: ProcessBitrixEventDeps,
  sourceText: string,
  existing: StoredBitrixPost | null
): Promise<ProcessResult> {
  if (!existing || !hasTelegramReference(existing)) {
    return ignoreEvent(event, deps.db, sourceText, existing, "inactive");
  }

  const storedMessages = await deps.db.listTelegramMessages(existing.id);
  const messagesToDelete =
    storedMessages.length > 0
      ? storedMessages
      : [
          {
            chatId: existing.chatId,
            tgMessageId: existing.mainMessageId
          }
        ];
  const deletedMessageIds: number[] = [];

  for (const message of messagesToDelete) {
    if (!message.chatId || !message.tgMessageId) {
      continue;
    }

    await deps.telegram.deleteMessage({
      chatId: message.chatId,
      messageId: message.tgMessageId
    });
    deletedMessageIds.push(message.tgMessageId);
  }

  await deps.db.replaceTelegramMessages(existing.id, []);
  await deps.db.updatePost(existing.id, {
    status: "ignored",
    chatId: null,
    mainMessageId: null,
    publicationKind: null,
    scheduledAt: null,
    sourceText,
    photos: event.photos,
    payloadHash: event.payloadHash,
    telegramText: null,
    lastError: null,
    scheduledRetryCount: 0,
    adminNotifiedAt: null
  });

  return {
    status: "deleted",
    bitrixId: event.bitrixId,
    reason: "inactive",
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
