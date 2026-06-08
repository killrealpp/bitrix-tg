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
});
