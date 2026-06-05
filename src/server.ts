import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config";
import {
  BitrixWebhookParseError,
  parseBitrixWebhook,
  type ParsedBitrixEvent
} from "./bitrix/parseWebhook";
import {
  HttpBitrixPhotoResolver,
  type BitrixPhotoResolver
} from "./bitrix/photoResolver";
import type { DbGateway } from "./db/DbGateway";
import { openSqliteGateway } from "./db/SqliteGateway";
import {
  processBitrixEvent,
  type MissingScheduleTimeAdminNotifier,
  type ProcessResult
} from "./poster/processBitrixEvent";
import { runDuePosts } from "./scheduler/runDuePosts";
import { redactErrorForLog, redactSensitiveText } from "./security/redaction";
import {
  TelegramBotApiClient,
  type TelegramClient
} from "./telegram/client";
import { TelegramScheduledFailureAdminNotifier } from "./telegram/adminNotifier";

export interface BuildAppDeps {
  db: DbGateway;
  telegram: TelegramClient;
  adminNotifier?: MissingScheduleTimeAdminNotifier;
  photoResolver?: BitrixPhotoResolver;
  config: Partial<
    Pick<
      AppConfig,
      | "webhookSecret"
      | "telegramBotToken"
      | "telegramAdminChatId"
      | "bitrixActiveFromField"
      | "bitrixRequireExactActiveFrom"
      | "bitrixLocalUtcOffsetMinutes"
      | "bitrixFileResolverUrl"
      | "telegramMediaSyncPolicy"
    >
  >;
}

const WEBHOOK_SECRET_HEADER = "x-webhook-secret";
const REDACTED_LOG_VALUE = "[redacted]";
export const LOG_REDACT_PATHS = [
  `req.headers["${WEBHOOK_SECRET_HEADER}"]`,
  `request.headers["${WEBHOOK_SECRET_HEADER}"]`,
  `headers["${WEBHOOK_SECRET_HEADER}"]`,
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization"
];

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const logSecrets = getLogSecrets(deps.config);
  const app = Fastify({
    logger: {
      redact: {
        paths: LOG_REDACT_PATHS,
        censor: REDACTED_LOG_VALUE
      }
    }
  });

  app.get("/health", async () => "OK");

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(
      { err: redactErrorForLog(error, logSecrets) },
      "Unhandled request error"
    );

    return reply.code(500).send({
      ok: false,
      error: "internal_error"
    });
  });

  app.post("/webhooks/bitrix", async (request, reply) => {
    if (
      !isValidWebhookSecret(
        request.headers[WEBHOOK_SECRET_HEADER],
        deps.config.webhookSecret
      )
    ) {
      return reply.code(401).send({
        ok: false,
        error: "unauthorized"
      });
    }

    try {
      const events = parseBitrixWebhook(request.body, {
        activeFromField: deps.config.bitrixActiveFromField,
        activeFromUtcOffsetMinutes: deps.config.bitrixLocalUtcOffsetMinutes
      });
      const results: ProcessResult[] = [];
      logParsedEvents(app, events);

      for (const event of events) {
        results.push(
          await processBitrixEvent(event, {
            db: deps.db,
            telegram: deps.telegram,
            adminNotifier: deps.adminNotifier,
            photoResolver: deps.photoResolver,
            mediaSyncPolicy: deps.config.telegramMediaSyncPolicy,
            requireExactScheduleTime:
              deps.config.bitrixRequireExactActiveFrom ?? false
          })
        );
      }
      logProcessingResults(app, events, results, logSecrets);

      return {
        ok: true,
        processed: events.length,
        published: results.filter((result) => result.status === "published").length,
        edited: results.filter((result) => result.status === "edited").length,
        scheduled: results.filter((result) => result.status === "scheduled").length,
        deleted: results.filter((result) => result.status === "deleted").length,
        ignored: results.filter((result) => result.status === "ignored").length,
        unchanged: results.filter((result) => result.status === "unchanged").length,
        failed: results.filter((result) => result.status === "failed").length,
        results
      };
    } catch (error) {
      if (error instanceof BitrixWebhookParseError) {
        return reply.code(400).send({
          ok: false,
          error: error.message
        });
      }

      throw error;
    }
  });

  return app;
}

function logParsedEvents(
  app: FastifyInstance,
  events: Array<{
    bitrixId: number;
    isActive: boolean;
    activeRaw: string;
    scheduledAt: Date | null;
    scheduledAtSourceField: string | null;
    scheduledAtRawValue: string | null;
    scheduledAtPrecision: string | null;
    photos: Array<{
      id?: string;
      url?: string;
      unresolved?: boolean;
    }>;
  }>
): void {
  for (const event of events) {
    app.log.info(
      {
        bitrixId: event.bitrixId,
        isActive: event.isActive,
        activeRaw: event.activeRaw,
        scheduledAt: event.scheduledAt?.toISOString() ?? null,
        scheduledAtSourceField: event.scheduledAtSourceField,
        scheduledAtRawValue: event.scheduledAtRawValue,
        scheduledAtPrecision: event.scheduledAtPrecision,
        photoCount: event.photos.length,
        photoUrlCount: event.photos.filter((photo) => Boolean(photo.url)).length,
        photoIds: event.photos
          .map((photo) => photo.id)
          .filter((id): id is string => Boolean(id)),
        photoUrls: event.photos
          .map((photo) => photo.url)
          .filter((url): url is string => Boolean(url))
          .slice(0, 5),
        unresolvedPhotoCount: event.photos.filter((photo) => photo.unresolved)
          .length
      },
      "Bitrix event parsed"
    );
  }
}

function logProcessingResults(
  app: FastifyInstance,
  events: ParsedBitrixEvent[],
  results: ProcessResult[],
  logSecrets: string[]
): void {
  results.forEach((result, index) => {
    const event = events[index];
    const payload = {
      bitrixId: result.bitrixId,
      status: result.status,
      reason: result.reason,
      messageIds: result.messageIds,
      error: result.error
        ? redactSensitiveText(result.error, logSecrets)
        : undefined,
      photoCount: event?.photos.length,
      photoUrlCount: event?.photos.filter((photo) => Boolean(photo.url)).length,
      unresolvedPhotoCount: event?.photos.filter((photo) => photo.unresolved)
        .length,
      scheduledAt: event?.scheduledAt?.toISOString() ?? null,
      scheduledAtRawValue: event?.scheduledAtRawValue,
      scheduledAtPrecision: event?.scheduledAtPrecision,
      expectedTelegramMethod: event ? expectedTelegramMethod(event) : undefined
    };

    if (result.status === "failed") {
      app.log.warn(payload, "Bitrix event processing failed");
      return;
    }

    app.log.info(payload, "Bitrix event processing completed");
  });
}

function expectedTelegramMethod(event: ParsedBitrixEvent): string {
  if (!event.isActive || isSocialValueMissing(event)) {
    return "none";
  }

  if (event.photos.length === 0) {
    return "sendMessage";
  }

  if (event.photos.length === 1) {
    return "sendPhoto";
  }

  return "sendMediaGroup";
}

function isSocialValueMissing(event: ParsedBitrixEvent): boolean {
  return Array.isArray(event.socialValue)
    ? event.socialValue.length === 0
    : event.socialValue.trim() === "";
}

function isValidWebhookSecret(
  provided: string | string[] | undefined,
  expected: string | undefined
): boolean {
  if (!expected) {
    return true;
  }

  if (typeof provided !== "string") {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function startServer(): Promise<void> {
  const config = loadConfig(process.env, { requireTelegram: true });
  const logSecrets = getLogSecrets(config);
  const db = await openSqliteGateway({
    filename: config.sqliteDbPath,
    migrationsDir: path.resolve(process.cwd(), "migrations")
  });
  const telegram = new TelegramBotApiClient({
    botToken: config.telegramBotToken ?? "",
    chatId: config.telegramChatId ?? "",
    messageThreadId: config.telegramMessageThreadId,
    parseMode: config.telegramParseMode,
    photoDeliveryMode: config.telegramPhotoDeliveryMode,
    photoDownloadTimeoutMs: config.telegramPhotoDownloadTimeoutMs,
    retryAttempts: config.telegramRetryAttempts,
    retryDelayMs: config.telegramRetryDelayMs
  });
  const adminTelegram = config.telegramAdminChatId
    ? new TelegramBotApiClient({
        botToken: config.telegramBotToken ?? "",
        chatId: config.telegramAdminChatId,
        parseMode: config.telegramParseMode,
        retryAttempts: config.telegramRetryAttempts,
        retryDelayMs: config.telegramRetryDelayMs
      })
    : null;
  const adminNotifier = adminTelegram
    ? new TelegramScheduledFailureAdminNotifier(adminTelegram)
    : undefined;
  const photoResolver = config.bitrixFileResolverUrl
    ? new HttpBitrixPhotoResolver({
        endpointUrl: config.bitrixFileResolverUrl
      })
    : undefined;
  const app = buildApp({
    db,
    telegram,
    adminNotifier,
    photoResolver,
    config
  });

  const scheduler = setInterval(() => {
    void (async () => {
      const result = await runDuePosts({
        db,
        telegram,
        adminNotifier,
        photoResolver
      });
      if (result.checked > 0 || result.published > 0 || result.failed > 0) {
        app.log.info({ result }, "Scheduled publishing worker result");
      }
    })().catch((error) => {
      app.log.error(
        { err: redactErrorForLog(error, logSecrets) },
        "Scheduled publishing worker failed"
      );
    });
  }, 30_000);
  scheduler.unref();

  app.addHook("onClose", async () => {
    clearInterval(scheduler);
    await db.close();
  });

  await app.listen({
    port: config.port,
    host: "0.0.0.0"
  });
}

if (require.main === module) {
  void startServer().catch((error) => {
    console.error(
      redactErrorForLog(error, [
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.WEBHOOK_SECRET
      ])
    );
    process.exit(1);
  });
}

function getLogSecrets(
  config: Partial<Pick<AppConfig, "telegramBotToken" | "webhookSecret">>
): string[] {
  return [config.telegramBotToken, config.webhookSecret].filter(
    (value): value is string => Boolean(value)
  );
}
