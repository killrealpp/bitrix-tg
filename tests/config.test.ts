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
    expect(example).toContain("TELEGRAM_PHOTO_DELIVERY_MODE=upload");
    expect(example).toContain("TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS=15000");
  });
});
