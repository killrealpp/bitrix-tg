import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("defaults the service port to 18080", () => {
    const config = loadConfig({});

    expect(config.port).toBe(18080);
  });

  it("loads the Bitrix active-from field override from env", () => {
    const config = loadConfig({
      BITRIX_ACTIVE_FROM_FIELD: "all_properties.CUSTOM_ACTIVE_FROM"
    });

    expect(config.bitrixActiveFromField).toBe(
      "all_properties.CUSTOM_ACTIVE_FROM"
    );
  });

  it("defaults exact Bitrix time validation to Moscow local time", () => {
    const config = loadConfig({});

    expect(config.bitrixRequireExactActiveFrom).toBe(true);
    expect(config.bitrixLocalUtcOffsetMinutes).toBe(180);
  });

  it("loads exact Bitrix time validation settings from env", () => {
    const config = loadConfig({
      BITRIX_REQUIRE_EXACT_ACTIVE_FROM: "false",
      BITRIX_LOCAL_UTC_OFFSET_MINUTES: "240"
    });

    expect(config.bitrixRequireExactActiveFrom).toBe(false);
    expect(config.bitrixLocalUtcOffsetMinutes).toBe(240);
  });

  it("loads Telegram retry settings from env", () => {
    const config = loadConfig({
      TELEGRAM_RETRY_ATTEMPTS: "5",
      TELEGRAM_RETRY_DELAY_MS: "125"
    });

    expect(config.telegramRetryAttempts).toBe(5);
    expect(config.telegramRetryDelayMs).toBe(125);
  });

  it("defaults Telegram photo delivery to service-side upload", () => {
    const config = loadConfig({});

    expect(config.telegramPhotoDeliveryMode).toBe("upload");
    expect(config.telegramPhotoDownloadTimeoutMs).toBe(15_000);
  });

  it("loads Telegram photo delivery settings from env", () => {
    const config = loadConfig({
      TELEGRAM_PHOTO_DELIVERY_MODE: "auto",
      TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS: "30000"
    });

    expect(config.telegramPhotoDeliveryMode).toBe("auto");
    expect(config.telegramPhotoDownloadTimeoutMs).toBe(30_000);
  });

  it("defaults media sync policy to rebuild", () => {
    const config = loadConfig({});

    expect(config.telegramMediaSyncPolicy).toBe("rebuild");
  });

  it("loads the admin notification chat id from env", () => {
    const config = loadConfig({
      TELEGRAM_ADMIN_CHAT_ID: "-100-admin"
    });

    expect(config.telegramAdminChatId).toBe("-100-admin");
  });

  it("loads the Bitrix file resolver URL from env", () => {
    const config = loadConfig({
      BITRIX_FILE_RESOLVER_URL: "https://bitrix.example.com/photos/resolve"
    });

    expect(config.bitrixFileResolverUrl).toBe(
      "https://bitrix.example.com/photos/resolve"
    );
  });

  it("loads incoming webhook debug dump settings from env", () => {
    const config = loadConfig({
      DEBUG_SAVE_INCOMING_WEBHOOK: "true",
      DEBUG_WEBHOOK_DUMP_PATH: "./data/debug/custom-webhook.json"
    });

    expect(config.debugSaveIncomingWebhook).toBe(true);
    expect(config.debugWebhookDumpPath).toBe("./data/debug/custom-webhook.json");
  });

  it("loads OpenRouter text fitting settings from env", () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: "openrouter-secret",
      OPENROUTER_MODEL: "anthropic/claude-3.5-haiku",
      OPENROUTER_SITE_URL: "https://svarnoy-market.ru",
      OPENROUTER_APP_TITLE: "Svarnoy Bot",
      OPENROUTER_TIMEOUT_MS: "30000"
    });

    expect(config.openRouterApiKey).toBe("openrouter-secret");
    expect(config.openRouterModel).toBe("anthropic/claude-3.5-haiku");
    expect(config.openRouterSiteUrl).toBe("https://svarnoy-market.ru");
    expect(config.openRouterAppTitle).toBe("Svarnoy Bot");
    expect(config.openRouterTimeoutMs).toBe(30_000);
  });

  it("keeps OPENAI_API_KEY and OPENAI_MODEL as OpenRouter-compatible fallbacks", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "legacy-openrouter-secret",
      OPENAI_MODEL: "gpt-4.1-mini"
    });

    expect(config.openRouterApiKey).toBe("legacy-openrouter-secret");
    expect(config.openRouterModel).toBe("openai/gpt-4.1-mini");
  });

  it("does not require the Bitrix file resolver URL when Telegram env is complete", () => {
    const config = loadConfig(
      {
        TELEGRAM_BOT_TOKEN: "123456:fake_token",
        TELEGRAM_CHAT_ID: "-100-channel"
      },
      { requireTelegram: true }
    );

    expect(config.bitrixFileResolverUrl).toBeUndefined();
  });

  it("documents the production admin chat id and local SQLite path in .env.example", () => {
    const example = readFileSync(".env.example", "utf8");

    expect(example).toContain("TELEGRAM_ADMIN_CHAT_ID=609150103");
    expect(example).toContain("SQLITE_DB_PATH=./data/bitrix-tg.sqlite");
    expect(example).toContain("BITRIX_FILE_RESOLVER_URL=");
    expect(example).toContain("BITRIX_REQUIRE_EXACT_ACTIVE_FROM=true");
    expect(example).toContain("BITRIX_LOCAL_UTC_OFFSET_MINUTES=180");
    expect(example).toContain("TELEGRAM_PHOTO_DELIVERY_MODE=upload");
    expect(example).toContain("TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS=15000");
    expect(example).toContain("OPENROUTER_API_KEY=");
    expect(example).toContain("OPENROUTER_MODEL=openai/gpt-4.1-mini");
    expect(example).toContain("DEBUG_SAVE_INCOMING_WEBHOOK=false");
    expect(example).toContain(
      "DEBUG_WEBHOOK_DUMP_PATH=./data/debug/last-bitrix-webhook.json"
    );
  });
});
