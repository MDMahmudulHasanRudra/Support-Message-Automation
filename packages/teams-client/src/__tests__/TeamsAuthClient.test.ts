import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamsAuthClient } from "../TeamsAuthClient.js";
import { TeamsOAuthError, classifyTokenError } from "../errors.js";
import { TEAMS_OAUTH_SCOPES } from "../types.js";

/**
 * Pure unit tests — mocks global fetch, no DB, no real network call, no real Microsoft tenant.
 * Covers the OAuth URL construction, token-exchange/refresh request shape, and — the actual
 * security-relevant behavior this refinement pass adds — that a rejected refresh token is
 * classified as REAUTH_REQUIRED while every other failure is TRANSIENT_ERROR, so
 * apps/worker/src/teams/tokenRefresh.ts writes the right TeamsAccountStatus.
 */

const CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  tenantId: "test-tenant-id",
  redirectUri: "https://example.invalid/api/teams/callback",
};

describe("TeamsAuthClient.getAuthorizationUrl", () => {
  it("builds a Microsoft v2.0 authorize URL with the requested scopes and a caller-supplied state", () => {
    const client = new TeamsAuthClient(CONFIG);
    const url = new URL(client.getAuthorizationUrl("random-state-value"));

    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("random-state-value");
    expect(url.searchParams.get("scope")).toBe(TEAMS_OAUTH_SCOPES.join(" "));
    // The customer's Microsoft password must never pass through our application — this URL is the
    // entire mechanism that guarantees that: we only ever redirect, never collect credentials.
    expect(url.searchParams.has("password")).toBe(false);
  });
});

describe("TeamsAuthClient token exchange", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acquireTokenByCode posts the authorization_code grant and returns a parsed token bundle", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: TEAMS_OAUTH_SCOPES.join(" ") }),
        { status: 200 },
      ),
    );

    const client = new TeamsAuthClient(CONFIG);
    const result = await client.acquireTokenByCode("auth-code-123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-123");
    expect(result.accessToken).toBe("at-1");
    expect(result.refreshToken).toBe("rt-1");
  });

  it("throws a TeamsOAuthError classified as REAUTH_REQUIRED when Microsoft rejects the refresh token with invalid_grant", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS700082: refresh token expired" }), {
        status: 400,
      }),
    );

    const client = new TeamsAuthClient(CONFIG);
    let caught: unknown;
    try {
      await client.refreshAccessToken("stale-refresh-token");
      expect.unreachable();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TeamsOAuthError);
    expect(classifyTokenError(caught)).toBe("REAUTH_REQUIRED");
  });

  it("classifies a transient Graph/network-shaped failure as TRANSIENT_ERROR, not REAUTH_REQUIRED", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "server busy" }), { status: 503 }),
    );

    const client = new TeamsAuthClient(CONFIG);
    try {
      await client.refreshAccessToken("some-refresh-token");
      expect.unreachable();
    } catch (err) {
      expect(classifyTokenError(err)).toBe("TRANSIENT_ERROR");
    }
  });

  it("classifies a plain thrown error (e.g. a network exception) as TRANSIENT_ERROR", () => {
    expect(classifyTokenError(new Error("fetch failed"))).toBe("TRANSIENT_ERROR");
  });
});
