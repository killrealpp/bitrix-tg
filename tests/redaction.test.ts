import { describe, expect, it } from "vitest";
import {
  redactErrorForLog,
  redactSensitiveText
} from "../src/security/redaction";

describe("sensitive text redaction", () => {
  it("redacts token, webhook secret, and authorization-shaped values", () => {
    const text = [
      "POST https://api.telegram.org/bot123456:fake_token/sendMessage",
      "Authorization: Bearer auth-secret",
      "x-webhook-secret: hook-value",
      "WEBHOOK_SECRET=env-secret",
      "TELEGRAM_BOT_TOKEN=123456:fake_token"
    ].join(" ");

    const redacted = redactSensitiveText(text, ["123456:fake_token"]);

    expect(redacted).not.toContain("123456:fake_token");
    expect(redacted).not.toContain("auth-secret");
    expect(redacted).not.toContain("hook-value");
    expect(redacted).not.toContain("env-secret");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts JSON-style header and env values", () => {
    const text = JSON.stringify({
      authorization: "Bearer auth-secret",
      "x-webhook-secret": "hook-value",
      WEBHOOK_SECRET: "env-secret",
      TELEGRAM_BOT_TOKEN: "123456:fake_token"
    });

    const redacted = redactSensitiveText(text, ["123456:fake_token"]);

    expect(redacted).not.toContain("123456:fake_token");
    expect(redacted).not.toContain("auth-secret");
    expect(redacted).not.toContain("hook-value");
    expect(redacted).not.toContain("env-secret");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts Error message and stack for log-safe output", () => {
    const error = new Error(
      "failed with raw-token authorization: Bearer auth-secret WEBHOOK_SECRET=hook-secret"
    );
    error.stack = [
      "Error: failed with raw-token",
      "Authorization: Bearer auth-secret",
      "WEBHOOK_SECRET=hook-secret"
    ].join("\n");

    const redacted = redactErrorForLog(error, ["raw-token"]);

    expect(redacted.message).not.toContain("raw-token");
    expect(redacted.message).not.toContain("auth-secret");
    expect(redacted.message).not.toContain("hook-secret");
    expect(redacted.stack).not.toContain("raw-token");
    expect(redacted.stack).not.toContain("auth-secret");
    expect(redacted.stack).not.toContain("hook-secret");
  });
});
