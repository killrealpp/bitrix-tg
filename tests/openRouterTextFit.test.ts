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
      platform: "telegram",
      publicationKind: "text",
      hasPhotos: false,
      target: 1200,
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
    expect(userMessage.content).toContain("Соцсеть публикации: Telegram");
    expect(userMessage.content).not.toContain("Новость компании");
  });

  it.each([
    ["telegram", "event", "формате «Событие»", "https://t.me/MagazinSvarnoy", "Telegram"],
    ["telegram", "promo", "формате «Акция»", "https://t.me/MagazinSvarnoy", "Telegram"],
    ["telegram", "company_news", "формате «Новость»", "https://t.me/MagazinSvarnoy", "Telegram"],
    ["telegram", "product_new", "формате «Новинка товара»", "https://t.me/MagazinSvarnoy", "Telegram"],
    [
      "max",
      "event",
      "формате «Событие»",
      "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs",
      "MAX"
    ],
    [
      "max",
      "promo",
      "формате «Акция»",
      "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs",
      "MAX"
    ],
    [
      "max",
      "company_news",
      "формате «Новость»",
      "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs",
      "MAX"
    ],
    [
      "max",
      "product_new",
      "формате «Новинка товара»",
      "https://max.ru/u/f9LHodD0cOKwuy14X3baQ2X3SDJPP2jeQ0E0_eAMmRoPvBvYzK4BqRoj3hs",
      "MAX"
    ]
  ] as const)(
    "uses the %s business SMM prompt for %s posts",
    async (platform, postType, marker, cta, platformLabel) => {
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
        platform,
        publicationKind: "text",
        hasPhotos: false,
        target: 1200,
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
      expect(userMessage.content).toContain(marker);
      expect(userMessage.content).toContain(cta);
      expect(userMessage.content).toContain("📌 Следите за нами:");
      expect(userMessage.content).toContain(
        platform === "telegram"
          ? "— MAX: https://max.ru/id4025424601_biz"
          : "— Telegram: https://t.me/svarnoymagazin"
      );
      expect(userMessage.content).not.toContain(
        platform === "telegram"
          ? "— Telegram: https://t.me/svarnoymagazin"
          : "— MAX: https://max.ru/id4025424601_biz"
      );
      expect(userMessage.content).toContain("— ВК: https://vk.com/svarnoy40");
      expect(userMessage.content).toContain("Используй настоящие переносы строк");
      expect(userMessage.content).toContain("обезличенные обороты");
      if (postType !== "promo") {
        expect(userMessage.content).toContain("Каждый пункт характеристик");
      }
      expect(userMessage.content).toContain("Длина поста: не более 1200 символов");
      expect(userMessage.content).toContain("Лимит: не более 1200 символов");
      expect(userMessage.content).toContain(`Соцсеть публикации: ${platformLabel}`);
      expect(userMessage.content).toContain(
        platform === "telegram"
          ? "Формат публикации: Telegram-текст без фото"
          : "Формат публикации: пост MAX"
      );
      expect(userMessage.content).not.toContain(
        "Один итоговый текст используется сразу для Telegram и MAX"
      );
      expect(userMessage.content).not.toContain("ВК как канал публикации сейчас отключён");
      expect(userMessage.content).not.toContain("WhatsApp");
      expect(userMessage.content).toContain("Заголовок: Заголовок");
      expect(userMessage.content).toContain("Ссылка на источник: https://example.com/news");
    }
  );

  it("adds a caption-specific Telegram prompt when the post has photos", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Короткий Telegram caption"
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
      postType: "company_news",
      platform: "telegram",
      publicationKind: "caption",
      hasPhotos: true,
      target: 950,
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
    expect(userMessage.content).toContain("Длина поста: не более 950 символов");
    expect(userMessage.content).toContain("Telegram-подписи к фото/альбому");
    expect(userMessage.content).toContain("CTA и блок «Следите за нами» обязательны");
    expect(userMessage.content).toContain("не сокращай ссылки");
    expect(userMessage.content).toContain("Формат публикации: Telegram-подпись к фото/альбому");
    expect(userMessage.content).toContain("Лимит: не более 950 символов");
    expect(userMessage.content).not.toContain("Длина поста: не более 1200 символов");
  });
});
