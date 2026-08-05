import { redactSensitiveText } from "../security/redaction";
import type {
  SocialTextPrepareRequest,
  TextFitOptions,
  TextFitRequest
} from "./fitText";
import { getPromptForPostType } from "./socialPrompts";

export interface OpenRouterTextFitOptions {
  apiKey: string;
  model: string;
  apiBaseUrl?: string;
  siteUrl?: string;
  appTitle?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: unknown;
  };
}

export function createOpenRouterTextFit(
  options: OpenRouterTextFitOptions
): TextFitOptions {
  const client = new OpenRouterTextFitter(options);
  return {
    aiFit: (request) => client.fit(request),
    aiPrepare: (request) => client.prepareSocialPost(request)
  };
}

export class OpenRouterTextFitter {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterTextFitOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://openrouter.ai/api/v1";
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fit(request: TextFitRequest): Promise<string> {
    return this.chatCompletion(buildMessages(request), Math.max(64, Math.ceil(request.target / 3)));
  }

  async prepareSocialPost(request: SocialTextPrepareRequest): Promise<string> {
    return this.chatCompletion(
      buildSocialPostMessages(request),
      Math.max(900, Math.ceil(request.target * 0.8))
    );
  }

  private async chatCompletion(
    messages: Array<{
      role: "system" | "user";
      content: string;
    }>,
    maxTokens: number
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify({
            model: this.options.model,
            messages,
            temperature: 0.2,
            max_tokens: maxTokens,
            stream: false
          }),
          signal: controller.signal
        }
      );

      const data = (await response.json()) as OpenRouterChatResponse;
      if (!response.ok) {
        throw new Error(
          `OpenRouter text fitting failed with HTTP ${response.status}: ${getOpenRouterError(data)}`
        );
      }

      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("OpenRouter text fitting returned an empty response");
      }

      return content.trim();
    } catch (error) {
      throw new Error(
        redactSensitiveText(
          error instanceof Error ? error.message : String(error),
          [this.options.apiKey]
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json"
    };

    if (this.options.siteUrl) {
      headers["HTTP-Referer"] = this.options.siteUrl;
    }

    if (this.options.appTitle) {
      headers["X-OpenRouter-Title"] = this.options.appTitle;
    }

    return headers;
  }
}

function buildMessages(request: TextFitRequest): Array<{
  role: "system" | "user";
  content: string;
}> {
  return [
    {
      role: "system",
      content: [
        "You shorten Bitrix news text for Telegram.",
        "Preserve facts, dates, names, prices, addresses, product names, and links.",
        "Do not add new facts, hashtags, greetings, or explanations.",
        "Keep the original language and neutral tone.",
        "Return only the final text."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Task: shorten this Telegram ${request.kind} to at most ${request.target} characters.`,
        `Hard limit: ${request.limit} characters.`,
        "Text:",
        request.text
      ].join("\n")
    }
  ];
}

function buildSocialPostMessages(request: SocialTextPrepareRequest): Array<{
  role: "system" | "user";
  content: string;
}> {
  return [
    {
      role: "system",
      content: [
        "Ты профессиональный SMM-копирайтер магазина сварочного оборудования,",
        "электроинструмента, силовой и садовой техники «СВАРНОЙ».",
        "Пиши на русском языке. Не выдумывай факты, даты, цены, адреса или условия.",
        "Верни только готовый текст поста без пояснений."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        getPromptForPostType(request.postType, request.platform),
        "",
        `Лимит: не более ${request.target} символов.`,
        `Соцсеть публикации: ${request.platform === "telegram" ? "Telegram" : "MAX"}.`,
        "",
        "Исходные данные:",
        `Заголовок: ${request.title || "нет"}`,
        `Анонс: ${request.previewText || "нет"}`,
        `Подробный текст: ${request.detailText || "нет"}`,
        `Дата и время: ${request.scheduledAtRawValue || "нет"}`,
        `Ссылка на источник: ${request.url || "нет"}`,
        "",
        "Текст для адаптации:",
        request.text
      ].join("\n")
    }
  ];
}

function getOpenRouterError(data: OpenRouterChatResponse): string {
  const message = data.error?.message;
  return redactSensitiveText(
    typeof message === "string" && message.trim() ? message : "unknown error"
  );
}
