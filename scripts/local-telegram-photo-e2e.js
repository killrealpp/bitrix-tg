const fs = require("node:fs");
const path = require("node:path");

const { buildApp } = require("../dist/src/server.js");
const { openSqliteGateway } = require("../dist/src/db/SqliteGateway.js");
const { TelegramBotApiClient } = require("../dist/src/telegram/client.js");
const { runDuePosts } = require("../dist/src/scheduler/runDuePosts.js");

const DEFAULT_PHOTO_URLS = [
  "https://placehold.co/600x400/png",
  "https://placehold.co/600x400.jpg"
];

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getPhotoUrls() {
  const raw = process.env.TELEGRAM_TEST_PHOTO_URLS;
  if (!raw) {
    return DEFAULT_PHOTO_URLS;
  }

  return raw
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function formatBitrixMoscow(dateUtc) {
  const shifted = new Date(dateUtc.getTime() + 180 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${pad(shifted.getUTCDate())}.${pad(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()}`,
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  ].join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cleanupMessages(telegram, messages) {
  for (const message of messages) {
    try {
      await telegram.deleteMessage({
        chatId: message.chatId,
        messageId: message.tgMessageId
      });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function main() {
  loadLocalEnv();
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.log("telegram_photo_e2e=skipped_missing_env");
    return;
  }

  const photoUrls = getPhotoUrls();
  if (photoUrls.length === 0) {
    throw new Error("TELEGRAM_TEST_PHOTO_URLS did not contain any URLs");
  }

  const db = await openSqliteGateway({ filename: ":memory:" });
  const telegram = new TelegramBotApiClient({
    botToken,
    chatId,
    photoDeliveryMode: process.env.TELEGRAM_PHOTO_DELIVERY_MODE || "upload",
    photoDownloadTimeoutMs: Number(process.env.TELEGRAM_PHOTO_DOWNLOAD_TIMEOUT_MS || 20000),
    retryAttempts: Number(process.env.TELEGRAM_RETRY_ATTEMPTS || 3),
    retryDelayMs: Number(process.env.TELEGRAM_RETRY_DELAY_MS || 500)
  });
  const app = buildApp({
    db,
    telegram,
    config: {
      bitrixRequireExactActiveFrom: true,
      bitrixLocalUtcOffsetMinutes: 180,
      telegramMediaSyncPolicy: "rebuild"
    }
  });

  const bitrixId = 880000 + Math.floor(Math.random() * 100000);
  const target = new Date(Math.ceil((Date.now() + 5000) / 1000) * 1000);
  const activeFrom = formatBitrixMoscow(target);
  const keepMessages = process.env.KEEP_TELEGRAM_TEST_MESSAGES === "1";

  try {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/bitrix",
      payload: [
        {
          body: {
            action: "update",
            element_id: bitrixId,
            active: "Y",
            pub_news_social: "2976",
            name: "LOCAL TEST scheduled album",
            detail_text: "Local bitrix-tg photo E2E.",
            active_from: activeFrom,
            all_properties: {
              PHOTOS: photoUrls.map((url, index) => ({
                id: `test-photo-${index + 1}`,
                url,
                path: `/test/photo-${index + 1}`
              }))
            }
          }
        }
      ]
    });
    const body = response.json();
    console.log(
      `webhook_result=${JSON.stringify({
        statusCode: response.statusCode,
        ok: body.ok,
        processed: body.processed,
        published: body.published,
        scheduled: body.scheduled,
        failed: body.failed,
        results: body.results
      })}`
    );

    if (response.statusCode !== 200 || body.scheduled !== 1) {
      throw new Error("expected webhook to store one scheduled post");
    }

    await sleep(Math.max(0, target.getTime() - Date.now() + 2000));
    let due = null;
    let post = null;
    let messages = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      due = await runDuePosts({
        db,
        telegram,
        now: new Date(),
        scheduledRetryDelayMs: 1000,
        maxScheduledRetries: 3
      });
      post = await db.findPostByBitrixId(bitrixId);
      messages = post ? await db.listTelegramMessages(post.id) : [];
      console.log(
        `scheduler_attempt_${attempt}=${JSON.stringify({
          result: due,
          postStatus: post && post.status,
          lastError: post && post.lastError
        })}`
      );

      if (due.published === 1 || post?.status === "failed") {
        break;
      }

      await sleep(1200);
    }

    console.log(
      `stored_post=${JSON.stringify({
        bitrixId: post && post.bitrixId,
        status: post && post.status,
        publicationKind: post && post.publicationKind,
        photoCount: post && post.photos.length,
        messageCount: messages.length,
        lastError: post && post.lastError,
        messageIds: messages.map((message) => message.tgMessageId),
        mediaUrls: messages.map((message) => message.mediaUrl)
      })}`
    );

    if (
      due.published !== 1 ||
      !post ||
      post.status !== "published" ||
      !["photo", "media_group"].includes(post.publicationKind || "") ||
      messages.length !== photoUrls.length
    ) {
      throw new Error("expected Telegram photo publication to succeed");
    }

    if (!keepMessages) {
      await cleanupMessages(telegram, messages);
      console.log("telegram_photo_e2e_cleanup=ok");
    } else {
      console.log("telegram_photo_e2e_cleanup=skipped_keep_messages");
    }

    console.log("telegram_photo_e2e=ok");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(
    `telegram_photo_e2e=failed ${
      error && error.message ? error.message : String(error)
    }`
  );
  process.exit(1);
});
