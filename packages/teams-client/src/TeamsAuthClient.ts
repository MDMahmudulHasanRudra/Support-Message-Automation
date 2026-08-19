import type { TeamsClientConfig, TeamsTokenBundle } from "./types.js";
import { TEAMS_OAUTH_SCOPES } from "./types.js";
import { TeamsOAuthError } from "./errors.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** Mirrors AnthropicClient's own request-shaping doc comment: a hard timeout so a slow Microsoft
 * endpoint can never block whichever caller (a web request, a worker tick) is awaiting this. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(body: TokenEndpointResponse, fallbackRefreshToken?: string): TeamsTokenBundle {
  if (body.error) {
    throw new TeamsOAuthError(
      `Microsoft token endpoint error: ${body.error} — ${body.error_description ?? "no description"}`,
      body.error,
    );
  }
  const refreshToken = body.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new TeamsOAuthError(
      "Microsoft token endpoint did not return a refresh_token (is 'offline_access' in the requested scopes?).",
      undefined,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    scopes: body.scope.split(" ").filter(Boolean),
  };
}

/**
 * Thin wrapper around the Microsoft identity platform's own documented OAuth 2.0 v2.0
 * authorization-code endpoints (learn.microsoft.com/entra/identity-platform) — plain REST calls
 * via native fetch, no SDK. Deliberately not @azure/msal-node: that library's token cache is
 * designed to be persisted as one opaque serialized blob, which doesn't fit this app's existing
 * "encrypt individual secret fields in our own schema" convention (see packages/db/src/index.ts's
 * encryptSecret/decryptSecret) — hand-rolling the well-documented, ~3-endpoint code flow directly
 * keeps token storage consistent with every other credential in this app and avoids an extra
 * dependency. Mirrors packages/ai-client's "thin wrapper package around one external service" shape.
 */
export class TeamsAuthClient {
  constructor(private readonly config: TeamsClientConfig) {}

  /** Redirect the admin's browser here to start the Microsoft consent flow. `state` should be a
   * random, single-use value the caller verifies on callback (CSRF protection). */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.config.redirectUri,
      response_mode: "query",
      scope: TEAMS_OAUTH_SCOPES.join(" "),
      state,
    });
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /** Exchanges the authorization code from the callback's `?code=` param for a token bundle. */
  async acquireTokenByCode(code: string): Promise<TeamsTokenBundle> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      scope: TEAMS_OAUTH_SCOPES.join(" "),
    });
    return this.requestToken(params);
  }

  /** Refreshes an expiring/expired access token. Microsoft may rotate the refresh token on any
   * given refresh — callers must always persist the (possibly new) refreshToken from the result,
   * never assume the input refreshToken stays valid. */
  async refreshAccessToken(refreshToken: string): Promise<TeamsTokenBundle> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: TEAMS_OAUTH_SCOPES.join(" "),
    });
    return this.requestToken(params, refreshToken);
  }

  private async requestToken(params: URLSearchParams, fallbackRefreshToken?: string): Promise<TeamsTokenBundle> {
    const response = await fetchWithTimeout(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = (await response.json()) as TokenEndpointResponse;
    if (!response.ok) {
      throw new TeamsOAuthError(
        `Microsoft token endpoint returned ${response.status}: ${body.error ?? ""} ${body.error_description ?? ""}`.trim(),
        body.error,
      );
    }
    return parseTokenResponse(body, fallbackRefreshToken);
  }
}
