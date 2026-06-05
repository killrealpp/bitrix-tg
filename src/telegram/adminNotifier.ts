import type { ScheduledFailureAdminNotifier } from "../scheduler/runDuePosts";
import type { MissingScheduleTimeAdminNotifier } from "../poster/processBitrixEvent";
import type { TelegramClient } from "./client";

export class TelegramScheduledFailureAdminNotifier
  implements ScheduledFailureAdminNotifier, MissingScheduleTimeAdminNotifier
{
  constructor(private readonly telegram: TelegramClient) {}

  async notifyScheduledPublishFailure(input: {
    bitrixId: number;
    error: string;
    retryCount: number;
  }): Promise<void> {
    await this.telegram.sendText({
      text: [
        "Bitrix-to-Telegram scheduled publication failed after retry.",
        `Bitrix element: ${input.bitrixId}`,
        `Retry count: ${input.retryCount}`,
        `Error: ${input.error}`
      ].join("\n")
    });
  }

  async notifyMissingScheduleTime(input: {
    bitrixId: number;
    sourceField: string | null;
    rawValue: string | null;
    error: string;
  }): Promise<void> {
    await this.telegram.sendText({
      text: [
        "Bitrix-to-Telegram publication blocked: exact activity time is missing.",
        `Bitrix element: ${input.bitrixId}`,
        `Field: ${input.sourceField ?? "unknown"}`,
        `Value: ${input.rawValue ?? "unknown"}`,
        `Error: ${input.error}`
      ].join("\n")
    });
  }

  async notifyPhotoResolutionFailure(input: {
    bitrixId: number;
    photoIds: string[];
    error: string;
  }): Promise<void> {
    await this.telegram.sendText({
      text: [
        "Bitrix-to-Telegram publication blocked: photo URL resolution failed.",
        `Bitrix element: ${input.bitrixId}`,
        `Photo ids: ${input.photoIds.join(", ") || "unknown"}`,
        `Error: ${input.error}`
      ].join("\n")
    });
  }
}
