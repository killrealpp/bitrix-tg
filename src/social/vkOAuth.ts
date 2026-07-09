import { createHash, randomBytes } from "node:crypto";
import type {
  DbGateway,
  StoredVkOauthToken
} from "../db/DbGateway";

export interface VkUserAccessTokenProvider {
  getAccessToken(): Promise<string>;
  refreshAccessToken(): Promise<string>;
}

export interface VkOAuthTokenServiceOptions {
  db: DbGateway;
  clientId: string;
  redirectUri: string;
  serviceToken?: string;
  scope?: string;
  authUrl?: string;
  tokenUrl?: string;
  refreshSkewMs?: number;
  stateTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface PendingVkOAuthState {
  codeVerifier: string;
  createdAt: number;
}

interface VkOAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  user_id?: unknown;
  scope?: unknown;
  state?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export class VkOAuthTokenService implements VkUserAccessTokenProvider {
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private readonly scope: string | undefined;
  private readonly refreshSkewMs: number;
  private readonly stateTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly pendingStates = new Map<string, PendingVkOAuthState>();
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly options: VkOAuthTokenServiceOptions) {
    this.authUrl = options.authUrl ?? "https://id.vk.ru/authorize";
    this.tokenUrl = options.tokenUrl ?? "https://id.vk.ru/oauth2/auth";
    this.scope = normalizeOptional(options.scope);
    this.refreshSkewMs = Math.max(0, options.refreshSkewMs ?? 5 * 60 * 1000);
    this.stateTtlMs = Math.max(60_000, options.stateTtlMs ?? 10 * 60 * 1000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  createAuthorizationUrl(): string {
    this.deleteExpiredPendingStates();

    const state = createRandomToken(32);
    const codeVerifier = createRandomToken(64);
    const codeChallenge = createCodeChallenge(codeVerifier);
    this.pendingStates.set(state, {
      codeVerifier,
      createdAt: this.now().getTime()
    });

    const url = new URL(this.authUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (this.scope) {
      url.searchParams.set("scope", this.scope);
    }

    return url.toString();
  }

  async handleCallback(query: Record<string, unknown>): Promise<StoredVkOauthToken> {
    const error = getQueryParam(query, "error");
    if (error) {
      const description = getQueryParam(query, "error_description") ?? error;
      throw new Error(`VK OAuth authorization failed: ${description}`);
    }

    const state = getRequiredQueryParam(query, "state");
    const code = getRequiredQueryParam(query, "code");
    const deviceId = getRequiredQueryParam(query, "device_id");
    const pending = this.pendingStates.get(state);
    if (!pending || this.isPendingStateExpired(pending)) {
      this.pendingStates.delete(state);
      throw new Error("VK OAuth state is missing or expired. Open /admin/vk/oauth/start again.");
    }

    const response = await this.requestToken({
      grant_type: "authorization_code",
      code_verifier: pending.codeVerifier,
      redirect_uri: this.options.redirectUri,
      code,
      client_id: this.options.clientId,
      device_id: deviceId,
      state
    });
    this.pendingStates.delete(state);

    if (response.state && response.state !== state) {
      throw new Error("VK OAuth state mismatch in token response");
    }

    return this.saveTokenResponse(response, deviceId);
  }

  async getAccessToken(): Promise<string> {
    const token = await this.options.db.getVkOauthToken();
    if (!token) {
      throw new Error(
        "VK OAuth token is not configured. Open /admin/vk/oauth/start and authorize VK access."
      );
    }

    if (token.expiresAt.getTime() > this.now().getTime() + this.refreshSkewMs) {
      return token.accessToken;
    }

    return this.refreshAccessToken();
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessTokenOnce().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async refreshAccessTokenOnce(): Promise<string> {
    const token = await this.options.db.getVkOauthToken();
    if (!token) {
      throw new Error(
        "VK OAuth token is not configured. Open /admin/vk/oauth/start and authorize VK access."
      );
    }

    const state = createRandomToken(32);
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: this.options.clientId,
      device_id: token.deviceId,
      state
    };
    if (this.scope) {
      params.scope = this.scope;
    }

    const response = await this.requestToken(params);
    const saved = await this.saveTokenResponse(response, token.deviceId);
    return saved.accessToken;
  }

  private async requestToken(
    params: Record<string, string>
  ): Promise<RequiredTokenResponse> {
    const body = new URLSearchParams(params);
    if (this.options.serviceToken) {
      body.set("service_token", this.options.serviceToken);
    }

    const response = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const data = (await response.json().catch(() => ({}))) as VkOAuthTokenResponse;
    if (!response.ok || data.error) {
      const description =
        typeof data.error_description === "string"
          ? data.error_description
          : typeof data.error === "string"
            ? data.error
            : `HTTP ${response.status}`;
      throw new Error(`VK OAuth token request failed: ${description}`);
    }

    return normalizeTokenResponse(data);
  }

  private async saveTokenResponse(
    response: RequiredTokenResponse,
    deviceId: string
  ): Promise<StoredVkOauthToken> {
    return this.options.db.saveVkOauthToken({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      deviceId,
      userId: response.userId,
      scope: response.scope,
      expiresAt: new Date(this.now().getTime() + response.expiresIn * 1000)
    });
  }

  private deleteExpiredPendingStates(): void {
    for (const [state, pending] of this.pendingStates.entries()) {
      if (this.isPendingStateExpired(pending)) {
        this.pendingStates.delete(state);
      }
    }
  }

  private isPendingStateExpired(pending: PendingVkOAuthState): boolean {
    return pending.createdAt + this.stateTtlMs < this.now().getTime();
  }
}

interface RequiredTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string | null;
  scope: string | null;
  state: string | null;
}

function normalizeTokenResponse(data: VkOAuthTokenResponse): RequiredTokenResponse {
  const accessToken = requireString(data.access_token, "access_token");
  const refreshToken = requireString(data.refresh_token, "refresh_token");
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("VK OAuth token response did not include a valid expires_in");
  }

  return {
    accessToken,
    refreshToken,
    expiresIn,
    userId:
      typeof data.user_id === "string" || typeof data.user_id === "number"
        ? String(data.user_id)
        : null,
    scope: typeof data.scope === "string" ? data.scope : null,
    state: typeof data.state === "string" ? data.state : null
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`VK OAuth token response did not include ${name}`);
  }

  return value;
}

function getRequiredQueryParam(query: Record<string, unknown>, key: string): string {
  const value = getQueryParam(query, key);
  if (!value) {
    throw new Error(`VK OAuth callback is missing ${key}`);
  }

  return value;
}

function getQueryParam(query: Record<string, unknown>, key: string): string | null {
  const value = query[key];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return null;
}

function createRandomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
