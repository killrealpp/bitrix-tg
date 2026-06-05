import type {
  DbGateway,
  PersistPostInput,
  PersistTelegramMessageInput,
  StoredBitrixPost,
  StoredTelegramMessage,
  UpdatePostPatch
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

export class FakeDbGateway implements DbGateway {
  posts: StoredBitrixPost[] = [];
  messages: StoredTelegramMessage[] = [];
  private nextPostId = 1;
  private nextMessageRowId = 1;

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
