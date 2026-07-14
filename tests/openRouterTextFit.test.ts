import { describe, expect, it, vi } from "vitest";
import { OpenRouterTextFitter } from "../src/text/openRouterTextFit";

describe("OpenRouterTextFitter", () => {
  it("calls OpenRouter chat completions and returns the fitted text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Short fitted text"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    const fitter = new OpenRouterTextFitter({
      apiKey: "openrouter-secret",
      model: "openai/gpt-4.1-mini",
      siteUrl: "https://svarnoy-market.ru",
      appTitle: "bitrix-tg",
      fetchImpl: fetchMock
    });

    const result = await fitter.fit({
      text: "Very long Bitrix news text",
      limit: 1024,
      target: 950,
      kind: "caption"
    });

    expect(result).toBe("Short fitted text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      authorization: "Bearer openrouter-secret",
      "content-type": "application/json",
      "HTTP-Referer": "https://svarnoy-market.ru",
      "X-OpenRouter-Title": "bitrix-tg"
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "openai/gpt-4.1-mini",
      temperature: 0.2,
      stream: false,
      messages: [
        {
          role: "system"
        },
        {
          role: "user"
        }
      ]
    });
  });

  it("redacts the API key from OpenRouter errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "bad authorization: Bearer openrouter-secret"
          }
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    const fitter = new OpenRouterTextFitter({
      apiKey: "openrouter-secret",
      model: "openai/gpt-4.1-mini",
      fetchImpl: fetchMock
    });

    await expect(
      fitter.fit({
        text: "Very long Bitrix news text",
        limit: 1024,
        target: 950,
        kind: "caption"
      })
    ).rejects.toThrow("[redacted]");
    await expect(
      fitter.fit({
        text: "Very long Bitrix news text",
        limit: 1024,
        target: 950,
        kind: "caption"
      })
    ).rejects.not.toThrow("openrouter-secret");
  });

  it("uses a format-only prompt for unknown social post types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "✨ Аккуратно оформленный текст"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    const fitter = new OpenRouterTextFitter({
      apiKey: "openrouter-secret",
      model: "openai/gpt-4.1-mini",
      fetchImpl: fetchMock
    });

    const result = await fitter.prepareSocialPost({
      text: "Обычный текст без категории",
      postType: "unknown",
      target: 1000,
      title: "Заголовок",
      previewText: "",
      detailText: "Обычный текст без категории",
      scheduledAtRawValue: null,
      url: ""
    });

    expect(result).toBe("✨ Аккуратно оформленный текст");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const userMessage = body.messages.find(
      (message: { role: string }) => message.role === "user"
    );
    expect(userMessage.content).toContain("Легкое оформление");
    expect(userMessage.content).toContain("Не переписывай текст как акцию");
    expect(userMessage.content).not.toContain("Новость компании");
  });

  it.each([
    ["event", "Событие"],
    ["promo", "Акция"],
    ["company_news", "Новость компании"]
  ] as const)("uses the business SMM prompt for %s posts", async (postType, marker) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Готовый SMM-пост"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );
    const fitter = new OpenRouterTextFitter({
      apiKey: "openrouter-secret",
      model: "openai/gpt-4.1-mini",
      fetchImpl: fetchMock
    });

    await fitter.prepareSocialPost({
      text: "Исходный текст",
      postType,
      target: 1000,
      title: "Заголовок",
      previewText: "Анонс",
      detailText: "Подробный текст",
      scheduledAtRawValue: "10.07.2026 12:00:00",
      url: "https://example.com/news"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const userMessage = body.messages.find(
      (message: { role: string }) => message.role === "user"
    );
    expect(userMessage.content).toContain(`Формат: «${marker}»`);
    expect(userMessage.content).toContain("Лимит: не более 1000 символов");
    expect(userMessage.content).toContain("Заголовок: Заголовок");
    expect(userMessage.content).toContain("Ссылка на источник: https://example.com/news");
  });
});
