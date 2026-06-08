import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const emptyToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    if (normalized === undefined || typeof normalized === "boolean") {
      return normalized;
    }

    if (typeof normalized === "string") {
      const text = normalized.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(text)) {
        return true;
      }

      if (["0", "false", "no", "n", "off"].includes(text)) {
        return false;
      }
    }

    return normalized;
  }, z.boolean().default(defaultValue));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(18080),
  NODE_ENV: z.string().default("development"),
  DB_ACCESS_MODE: z
    .enum(["sqlite", "direct_postgres", "n8n_gateway"])
    .default("sqlite"),
  SQLITE_DB_PATH: z.string().default("./data/bitrix-tg.sqlite"),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  N8N_DB_GATEWAY_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  N8N_DB_GATEWAY_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_CHAT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_ADMIN_CHAT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  TELEGRAM_MESSAGE_THREAD_ID: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().optional()
  ),
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENROUTER_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENROUTER_MODEL: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENROUTER_API_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OPENROUTER_APP_TITLE: z.string().default("bitrix-tg"),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  BITRIX_ACTIVE_FROM_FIELD: z.preprocess(emptyToUndefined, z.string().optional()),
  BITRIX_REQUIRE_EXACT_ACTIVE_FROM: booleanFromEnv(true),
  BITRIX_LOCAL_UTC_OFFSET_MINUTES: z.coerce.number().int().default(180),
  BITRIX_FILE_RESOLVER_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  TELEGRAM_PARSE_MODE: z.enum(["plain", "html", "markdownv2"]).default("plain"),
  TELEGRAM_MEDIA_SYNC_POLICY: z.enum(["soft", "rebuild"]).default("rebuild"),
  TELEGRAM_PHOTO_DELIVERY_MODE: z.enum(["upload", "auto", "url"]).default("upload"),
  TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  TELEGRAM_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  TELEGRAM_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(500)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export interface LoadConfigOptions {
  requireTelegram?: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {}
) {
  const parsed = EnvSchema.parse(env);

  if (parsed.DB_ACCESS_MODE !== "sqlite") {
    throw new Error(
      `DB_ACCESS_MODE=${parsed.DB_ACCESS_MODE} is documented for later use but not implemented yet`
    );
  }

  if (options.requireTelegram) {
    if (!parsed.TELEGRAM_BOT_TOKEN) {
      throw new Error("TELEGRAM_BOT_TOKEN is required to start the real server");
    }

    if (!parsed.TELEGRAM_CHAT_ID) {
      throw new Error("TELEGRAM_CHAT_ID is required to start the real server");
    }

  }

  const telegramParseMode: "HTML" | "MarkdownV2" | undefined =
    parsed.TELEGRAM_PARSE_MODE === "plain"
      ? undefined
      : parsed.TELEGRAM_PARSE_MODE === "html"
        ? "HTML"
        : "MarkdownV2";
  const openRouterModel =
    parsed.OPENROUTER_MODEL ?? normalizeOpenRouterModel(parsed.OPENAI_MODEL);

  return {
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    dbAccessMode: parsed.DB_ACCESS_MODE,
    sqliteDbPath: parsed.SQLITE_DB_PATH,
    databaseUrl: parsed.DATABASE_URL,
    n8nDbGatewayUrl: parsed.N8N_DB_GATEWAY_URL,
    n8nDbGatewaySecret: parsed.N8N_DB_GATEWAY_SECRET,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramChatId: parsed.TELEGRAM_CHAT_ID,
    telegramAdminChatId: parsed.TELEGRAM_ADMIN_CHAT_ID,
    telegramMessageThreadId: parsed.TELEGRAM_MESSAGE_THREAD_ID,
    openAiApiKey: parsed.OPENAI_API_KEY,
    openAiModel: parsed.OPENAI_MODEL,
    openRouterApiKey: parsed.OPENROUTER_API_KEY ?? parsed.OPENAI_API_KEY,
    openRouterModel,
    openRouterApiBaseUrl: parsed.OPENROUTER_API_BASE_URL,
    openRouterSiteUrl: parsed.OPENROUTER_SITE_URL,
    openRouterAppTitle: parsed.OPENROUTER_APP_TITLE,
    openRouterTimeoutMs: parsed.OPENROUTER_TIMEOUT_MS,
    webhookSecret: parsed.WEBHOOK_SECRET,
    bitrixActiveFromField: parsed.BITRIX_ACTIVE_FROM_FIELD,
    bitrixRequireExactActiveFrom: parsed.BITRIX_REQUIRE_EXACT_ACTIVE_FROM,
    bitrixLocalUtcOffsetMinutes: parsed.BITRIX_LOCAL_UTC_OFFSET_MINUTES,
    bitrixFileResolverUrl: parsed.BITRIX_FILE_RESOLVER_URL,
    telegramParseMode,
    telegramMediaSyncPolicy: parsed.TELEGRAM_MEDIA_SYNC_POLICY,
    telegramPhotoDeliveryMode: parsed.TELEGRAM_PHOTO_DELIVERY_MODE,
    telegramPhotoDownloadTimeoutMs: parsed.TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS,
    telegramRetryAttempts: parsed.TELEGRAM_RETRY_ATTEMPTS,
    telegramRetryDelayMs: parsed.TELEGRAM_RETRY_DELAY_MS
  };
}

function normalizeOpenRouterModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "openai/gpt-4.1-mini";
  }

  if (trimmed.includes("/")) {
    return trimmed;
  }

  if (/^gpt-/i.test(trimmed) || /^o\d/i.test(trimmed)) {
    return `openai/${trimmed}`;
  }

  return trimmed;
}
