import { describe, expect, it, vi } from "vitest";
import { VkOAuthTokenService } from "../src/social/vkOAuth";
import { FakeDbGateway } from "./fakes";

describe("VkOAuthTokenService", () => {
  it("builds a VK authorization URL and exchanges callback code for tokens", async () => {
    const db = new FakeDbGateway();
    const tokenRequests: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokenRequests.push(bodyParams(init));
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        user_id: 123,
        scope: "wall photos groups",
        state: tokenRequests[0].get("state")
      });
    });
    const service = new VkOAuthTokenService({
      db,
      clientId: "client-id",
      redirectUri: "https://poster.example/admin/vk/oauth/callback",
      serviceToken: "service-token",
      scope: "wall photos groups",
      authUrl: "https://id.vk.ru/authorize",
      tokenUrl: "https://id.vk.ru/oauth2/auth",
      fetchImpl: fetchMock,
      now: () => new Date("2026-07-08T12:00:00.000Z")
    });

    const url = new URL(service.createAuthorizationUrl());
    expect(url.origin + url.pathname).toBe("https://id.vk.ru/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://poster.example/admin/vk/oauth/callback"
    );
    expect(url.searchParams.get("scope")).toBe("wall photos groups");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    const saved = await service.handleCallback({
      code: "callback-code",
      state: url.searchParams.get("state"),
      device_id: "device-1"
    });

    expect(saved).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      deviceId: "device-1",
      userId: "123",
      scope: "wall photos groups"
    });
    expect(saved.expiresAt.toISOString()).toBe("2026-07-08T13:00:00.000Z");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0].get("code")).toBe("callback-code");
    expect(tokenRequests[0].get("code_verifier")).toBeTruthy();
    expect(tokenRequests[0].get("service_token")).toBe("service-token");
  });

  it("refreshes an expired access token and stores the rotated refresh token", async () => {
    const db = new FakeDbGateway();
    await db.saveVkOauthToken({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      deviceId: "device-1",
      expiresAt: new Date("2026-07-08T11:59:00.000Z")
    });
    const tokenRequests: URLSearchParams[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokenRequests.push(bodyParams(init));
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        user_id: 123,
        scope: "wall photos groups"
      });
    });
    const service = new VkOAuthTokenService({
      db,
      clientId: "client-id",
      redirectUri: "https://poster.example/admin/vk/oauth/callback",
      tokenUrl: "https://id.vk.ru/oauth2/auth",
      fetchImpl: fetchMock,
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      refreshSkewMs: 5 * 60 * 1000
    });

    await expect(service.getAccessToken()).resolves.toBe("new-access");

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0].get("refresh_token")).toBe("old-refresh");
    expect(tokenRequests[0].get("device_id")).toBe("device-1");
    expect(db.vkOauthToken).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
  });
});

function bodyParams(init?: RequestInit): URLSearchParams {
  if (init?.body instanceof URLSearchParams) {
    return init.body;
  }

  return new URLSearchParams(String(init?.body ?? ""));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
