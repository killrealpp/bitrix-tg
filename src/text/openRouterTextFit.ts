import { redactSensitiveText } from "../security/redaction";
import type {
  SocialTextPrepareRequest,
  TextFitOptions,
  TextFitRequest
} from "./fitText";

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
    return this.chatCompletion(buildSocialPostMessages(request), 900);
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
        getPromptForPostType(request.postType),
        "",
        `Лимит: не более ${request.target} символов.`,
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

function getPromptForPostType(postType: SocialTextPrepareRequest["postType"]): string {
  if (postType === "event") {
    return [
      "Формат: «Событие». Адаптируй информацию о предстоящем мероприятии в пост-приглашение.",
      "Тон: экспертный, гостеприимный, без крика и навязчивости.",
      "Структура: заголовок с умеренным эмодзи 📅/🗓/📍; что это за событие, кто проводит, где и когда;",
      "2-3 практические причины посетить с ✅; детали участия; мягкий призыв написать в @MagazinSvarnoy;",
      "3-5 релевантных хэштегов.",
      "Не копируй исходный текст дословно. Сохрани все даты, время и адрес. Не больше 2-4 эмодзи."
    ].join(" ");
  }

  if (postType === "promo") {
    return [
      "Формат: «Акция». Адаптируй информацию об акции, скидке, спецпредложении или распродаже.",
      "Тон: энергичный и деловой, без крика, воды и рекламных штампов.",
      "Структура: заголовок с умеренным эмодзи 🔥/💸/⚡️/🎁; условия акции и сроки;",
      "2-3 выгоды для покупателя с ✅; цена только если она дана в исходных данных;",
      "если цены нет, напиши: «💰 Специальная цена на эту линейку. Узнайте вашу выгоду в чате за 1 минуту»;",
      "мягкий призыв написать в @MagazinSvarnoy; 3-5 релевантных хэштегов.",
      "Не выдумывай цифры, сроки или цены. Не пиши «цена на сайте»."
    ].join(" ");
  }

  if (postType === "company_news") {
    return [
      "Формат: «Новость компании». Адаптируй новость в деловой пост.",
      "Тон: экспертный, уважительный, без пафоса и рекламных штампов.",
      "Структура: заголовок с умеренным эмодзи 📢/📰/📌; 3-5 строк с ключевыми фактами;",
      "почему это важно или полезно клиенту; детали без перегрузки; мягкий призыв написать в @MagazinSvarnoy;",
      "3-5 релевантных хэштегов.",
      "Не копируй исходный текст дословно и не выдумывай факты."
    ].join(" ");
  }

  return [
    "Формат: «Легкое оформление». Это развлекательный или прочий контент.",
    "Не переписывай текст как акцию, событие или новость компании.",
    "Сохрани исходный смысл, факты, порядок мыслей и формулировки максимально близко к оригиналу.",
    "Разрешено только аккуратно оформить: убрать лишние пробелы, разбить на короткие абзацы или простой список, добавить 1-3 уместных эмодзи для настроения.",
    "Не добавляй новые факты, цены, сроки, адреса, обещания, призывы к покупке и хэштеги, если их не было в исходном тексте.",
    "Тон: живой, аккуратный, без крика и рекламных штампов. Верни только готовый текст."
  ].join(" ");
}

function getOpenRouterError(data: OpenRouterChatResponse): string {
  const message = data.error?.message;
  return redactSensitiveText(
    typeof message === "string" && message.trim() ? message : "unknown error"
  );
}
