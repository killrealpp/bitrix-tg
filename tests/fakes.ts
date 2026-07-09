import type {
  DbGateway,
  PersistPostInput,
  PersistTelegramMessageInput,
  PersistVkOauthTokenInput,
  SocialPublicationTarget,
  StoredBitrixPost,
  StoredSocialPublication,
  StoredTelegramMessage,
  StoredVkOauthToken,
  UpdatePostPatch,
  UpsertSocialPublicationInput
} from "../src/db/DbGateway";
import type {
  BitrixPhotoResolver
} from "../src/bitrix/photoResolver";
import type { NormalizedPhoto } from "../src/bitrix/parseWebhook";
import type {
  EditCaptionInput,
  DeleteMessageInput,
  EditMediaInput,
  EditTextInput,
  SendMediaGroupInput,
  SendPhotoInput,
  SendTextInput,
  TelegramClient,
  TelegramMessageRef
} from "../src/telegram/client";
import type {
  ExternalDeleteInput,
  ExternalPublishInput,
  ExternalPublishResult,
  ExternalSocialPublisher,
  ExternalSocialTarget
} from "../src/social/types";

export class FakeDbGateway implements DbGateway {
  posts: StoredBitrixPost[] = [];
  messages: StoredTelegramMessage[] = [];
  socialPublications: StoredSocialPublication[] = [];
  vkOauthToken: StoredVkOauthToken | null = null;
  private nextPostId = 1;
  private nextMessageRowId = 1;
  private nextSocialPublicationId = 1;

  async findPostByBitrixId(bitrixId: number): Promise<StoredBitrixPost | null> {
    return this.posts.find((post) => post.bitrixId === bitrixId) ?? null;
  }

  async createPost(input: PersistPostInput): Promise<StoredBitrixPost> {
    const now = new Date();
    const post: StoredBitrixPost = {
      id: this.nextPostId++,
      bitrixId: input.bitrixId,
      status: input.status,
      chatId: input.chatId ?? null,
      mainMessageId: input.mainMessageId ?? null,
      publicationKind: input.publicationKind ?? null,
      scheduledAt: input.scheduledAt ?? null,
      sourceText: input.sourceText,
      telegramText: input.telegramText ?? null,
      preparedText: input.preparedText ?? null,
      postType: input.postType ?? "unknown",
      publishTargets: input.publishTargets ?? {
        telegram: true,
        vk: false,
        max: false
      },
      photos: input.photos,
      payloadHash: input.payloadHash,
      lastError: input.lastError ?? null,
      scheduledRetryCount: input.scheduledRetryCount ?? 0,
      adminNotifiedAt: input.adminNotifiedAt ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.posts.push(post);
    return post;
  }

  async updatePost(id: number, patch: UpdatePostPatch): Promise<StoredBitrixPost> {
    const post = this.posts.find((entry) => entry.id === id);
    if (!post) {
      throw new Error(`Post ${id} not found`);
    }

    Object.assign(post, patch, { updatedAt: new Date() });
    return post;
  }

  async replaceTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void> {
    this.messages = this.messages.filter((message) => message.postId !== postId);
    await this.appendTelegramMessages(postId, messages);
  }

  async appendTelegramMessages(
    postId: number,
    messages: PersistTelegramMessageInput[]
  ): Promise<void> {
    const now = new Date();
    this.messages.push(
      ...messages.map((message) => ({
        id: this.nextMessageRowId++,
        postId,
        chatId: message.chatId,
        tgMessageId: message.tgMessageId,
        role: message.role,
        mediaIndex: message.mediaIndex ?? null,
        mediaUrl: message.mediaUrl ?? null,
        telegramFileId: message.telegramFileId ?? null,
        createdAt: now,
        updatedAt: now
      }))
    );
  }

  async listTelegramMessages(postId: number): Promise<StoredTelegramMessage[]> {
    return this.messages.filter((message) => message.postId === postId);
  }

  async findDueScheduledPosts(now: Date, limit: number): Promise<StoredBitrixPost[]> {
    return this.posts
      .filter(
        (post) =>
          post.status === "scheduled" &&
          post.scheduledAt !== null &&
          post.scheduledAt.getTime() <= now.getTime()
      )
      .slice(0, limit);
  }

  async listSocialPublications(postId: number): Promise<StoredSocialPublication[]> {
    return this.socialPublications.filter((publication) => publication.postId === postId);
  }

  async findSocialPublication(
    postId: number,
    target: SocialPublicationTarget
  ): Promise<StoredSocialPublication | null> {
    return (
      this.socialPublications.find(
        (publication) => publication.postId === postId && publication.target === target
      ) ?? null
    );
  }

  async upsertSocialPublication(
    postId: number,
    input: UpsertSocialPublicationInput
  ): Promise<StoredSocialPublication> {
    const now = new Date();
    const existing = await this.findSocialPublication(postId, input.target);
    if (existing) {
      Object.assign(existing, {
        status: input.status,
        externalId: input.externalId ?? null,
        externalChatId: input.externalChatId ?? null,
        publicationKind: input.publicationKind ?? null,
        sentText: input.sentText ?? null,
        photos: input.photos ?? [],
        payloadHash: input.payloadHash ?? null,
        lastError: input.lastError ?? null,
        publishedAt: input.publishedAt ?? null,
        deletedAt: input.deletedAt ?? null,
        updatedAt: now
      });
      return existing;
    }

    const publication: StoredSocialPublication = {
      id: this.nextSocialPublicationId++,
      postId,
      target: input.target,
      status: input.status,
      externalId: input.externalId ?? null,
      externalChatId: input.externalChatId ?? null,
      publicationKind: input.publicationKind ?? null,
      sentText: input.sentText ?? null,
      photos: input.photos ?? [],
      payloadHash: input.payloadHash ?? null,
      lastError: input.lastError ?? null,
      publishedAt: input.publishedAt ?? null,
      deletedAt: input.deletedAt ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.socialPublications.push(publication);
    return publication;
  }

  async getVkOauthToken(): Promise<StoredVkOauthToken | null> {
    return this.vkOauthToken;
  }

  async saveVkOauthToken(
    input: PersistVkOauthTokenInput
  ): Promise<StoredVkOauthToken> {
    const now = new Date();
    this.vkOauthToken = {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      deviceId: input.deviceId,
      userId: input.userId ?? null,
      scope: input.scope ?? null,
      expiresAt: input.expiresAt,
      createdAt: this.vkOauthToken?.createdAt ?? now,
      updatedAt: now
    };

    return this.vkOauthToken;
  }

  async close(): Promise<void> {}
}

export class FakeTelegramClient implements TelegramClient {
  calls: Array<{ method: string; input: unknown }> = [];
  private nextMessageId = 100;

  async sendText(input: SendTextInput): Promise<TelegramMessageRef> {
    this.calls.push({ method: "sendText", input });
    return this.ref("text");
  }

  async editText(input: EditTextInput): Promise<TelegramMessageRef> {
    this.calls.push({ method: "editText", input });
    return {
      chatId: input.chatId,
      messageId: input.messageId,
      role: "text"
    };
  }

  async sendPhoto(input: SendPhotoInput): Promise<TelegramMessageRef> {
    this.calls.push({ method: "sendPhoto", input });
    return this.ref(input.role ?? "photo", 0, input.photo.url ?? "");
  }

  async sendMediaGroup(input: SendMediaGroupInput): Promise<TelegramMessageRef[]> {
    this.calls.push({ method: "sendMediaGroup", input });
    return input.photos.map((photo, index) =>
      this.ref(input.role ?? "album_item", index, photo.url ?? "")
    );
  }

  async editCaption(input: EditCaptionInput): Promise<TelegramMessageRef> {
    this.calls.push({ method: "editCaption", input });
    return {
      chatId: input.chatId,
      messageId: input.messageId,
      role: "photo"
    };
  }

  async editMedia(input: EditMediaInput): Promise<TelegramMessageRef> {
    this.calls.push({ method: "editMedia", input });
    return {
      chatId: input.chatId,
      messageId: input.messageId,
      role: input.role ?? "photo",
      mediaIndex: input.mediaIndex,
      mediaUrl: input.photo.url ?? ""
    };
  }

  async deleteMessage(input: DeleteMessageInput): Promise<void> {
    this.calls.push({ method: "deleteMessage", input });
  }

  private ref(
    role: TelegramMessageRef["role"],
    mediaIndex?: number,
    mediaUrl?: string
  ): TelegramMessageRef {
    return {
      chatId: "-100-test",
      messageId: this.nextMessageId++,
      role,
      mediaIndex,
      mediaUrl
    };
  }
}

export class FakeBitrixPhotoResolver implements BitrixPhotoResolver {
  calls: NormalizedPhoto[][] = [];
  throwError: Error | null = null;

  constructor(
    private readonly photosById: Record<string, NormalizedPhoto> = {}
  ) {}

  async resolvePhotos(photos: NormalizedPhoto[]): Promise<NormalizedPhoto[]> {
    this.calls.push(photos);
    if (this.throwError) {
      throw this.throwError;
    }

    return photos.map((photo) => {
      if (!photo.id || (!photo.unresolved && photo.url)) {
        return photo;
      }

      return this.photosById[photo.id] ?? photo;
    });
  }
}

export class FakeExternalPublisher implements ExternalSocialPublisher {
  publishCalls: ExternalPublishInput[] = [];
  deleteCalls: ExternalDeleteInput[] = [];
  failPublish: Error | null = null;
  failDelete: Error | null = null;
  private nextId = 1;

  constructor(readonly target: ExternalSocialTarget) {}

  async publish(input: ExternalPublishInput): Promise<ExternalPublishResult> {
    this.publishCalls.push(input);
    if (this.failPublish) {
      throw this.failPublish;
    }

    return {
      target: this.target,
      externalId: `${this.target}-${this.nextId++}`,
      externalChatId: `${this.target}-chat`,
      publicationKind:
        input.photos.length === 0
          ? "text"
          : input.photos.length === 1
            ? "photo"
            : "media_group",
      sentText: input.text,
      photos: input.photos
    };
  }

  async delete(input: ExternalDeleteInput): Promise<void> {
    this.deleteCalls.push(input);
    if (this.failDelete) {
      throw this.failDelete;
    }
  }
}
