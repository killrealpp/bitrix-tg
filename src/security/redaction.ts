const REDACTED = "[redacted]";

export interface RedactedLogError {
  name: string;
  message: string;
  stack?: string;
}

export function redactSensitiveText(
  input: string,
  explicitSecrets: Array<string | null | undefined> = []
): string {
  let output = input;

  for (const secret of explicitSecrets
    .filter((value): value is string => Boolean(value))
    .sort((first, second) => second.length - first.length)) {
    output = output.split(secret).join(REDACTED);
  }

  return output
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, `bot${REDACTED}`)
    .replace(
      /((?:["'])?\bauthorization(?:["'])?\s*[:=]\s*(?:["'])?(?:Bearer\s+)?)[^"',;\s}&]+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /((?:["'])?\bx-webhook-secret(?:["'])?\s*[:=]\s*(?:["'])?)[^"',;\s}&]+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /((?:["'])?\b(?:TELEGRAM_BOT_TOKEN|WEBHOOK_SECRET)(?:["'])?\s*[:=]\s*(?:["'])?)[^"',;\s}&]+/gi,
      `$1${REDACTED}`
    );
}

export function redactErrorForLog(
  error: unknown,
  explicitSecrets: Array<string | null | undefined> = []
): RedactedLogError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveText(error.message, explicitSecrets),
      stack: error.stack
        ? redactSensitiveText(error.stack, explicitSecrets)
        : undefined
    };
  }

  return {
    name: "NonError",
    message: redactSensitiveText(String(error), explicitSecrets)
  };
}
