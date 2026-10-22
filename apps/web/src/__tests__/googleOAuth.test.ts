import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Google Sheets Phase 1, the pure parts (GOOGLE_SHEETS.md): the consent URL, PKCE, the sealed OAuth
 * state, and the Google HTTP calls against a fake `fetch`. No database, no network.
 */

beforeAll(() => {
  process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const oauth = await import("@/server/google/oauth");
const api = await import("@/server/google/api");

const CONFIG = { clientId: "client-123.apps.googleusercontent.com", clientSecret: "shh-secret", redirectUri: "https://assist.example.com/api/google/oauth/callback" };

describe("configuration", () => {
  it("is absent until the server has a client id, a secret and a public address", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "x");
    vi.stubEnv("NEXTAUTH_URL", "https://assist.example.com");
    expect(oauth.googleOAuthConfig()).toBeNull();
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id");
    expect(oauth.googleOAuthConfig()).toEqual({ clientId: "id", clientSecret: "x", redirectUri: "https://assist.example.com/api/google/oauth/callback" });
  });

  it("builds ONE redirect URI from the public address, whatever path NEXTAUTH_URL carries", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://zoventio.example.com/some/path");
    expect(oauth.expectedRedirectUri()).toBe("https://zoventio.example.com/api/google/oauth/callback");
    vi.stubEnv("NEXTAUTH_URL", "not a url");
    expect(oauth.expectedRedirectUri()).toBeNull();
  });
});

describe("the consent URL", () => {
  it("asks for offline access, the module's scopes and nothing else, with PKCE and the state", () => {
    const state = oauth.newOAuthState("isp-digital", "user-1");
    const url = new URL(oauth.authorizationUrl(CONFIG, state));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CONFIG.clientId);
    expect(p.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toContain("consent");
    expect(p.get("state")).toBe(state.state);
    expect(p.get("code_challenge_method")).toBe("S256");
    const expected = createHash("sha256").update(state.verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(p.get("code_challenge")).toBe(expected);
    expect(p.get("scope")!.split(" ").sort()).toEqual(
      [
        "email",
        "openid",
        "profile",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
        // Phase 8: optional — an account that unticks it still connects.
        "https://www.googleapis.com/auth/drive.activity.readonly",
      ].sort(),
    );
    // Never the secret, never the verifier.
    expect(url.toString()).not.toContain(CONFIG.clientSecret);
    expect(url.toString()).not.toContain(state.verifier);
  });
});

describe("the sealed state", () => {
  it("round-trips, and the cookie does not reveal the verifier, the project or the user", () => {
    const state = oauth.newOAuthState("isp-digital", "user-1");
    const sealed = oauth.sealOAuthState(state);
    expect(sealed).not.toContain(state.verifier);
    expect(sealed).not.toContain("isp-digital");
    expect(sealed).not.toContain("user-1");
    expect(oauth.openOAuthState(sealed)).toEqual(state);
  });

  it("refuses a tampered, foreign, malformed or expired cookie", () => {
    const state = oauth.newOAuthState("isp-digital", "user-1", Date.now());
    const sealed = oauth.sealOAuthState(state);
    const flipped = sealed.slice(0, -4) + (sealed.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(oauth.openOAuthState(flipped)).toBeNull();
    expect(oauth.openOAuthState("garbage")).toBeNull();
    expect(oauth.openOAuthState(undefined)).toBeNull();
    expect(oauth.openOAuthState(sealed, Date.now() + oauth.STATE_TTL_MS + 1000)).toBeNull();
  });

  it("the cookie is HTTP-only and only ever sent to the callback", () => {
    const options = oauth.stateCookieOptions(600);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/google/oauth/callback", maxAge: 600 });
  });
});

describe("Google's HTTP answers", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("redeems a code with the PKCE verifier and reads the grant", async () => {
    let sent: URLSearchParams | null = null;
    const fake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/spreadsheets" });
    });
    const tokens = await api.exchangeCode(CONFIG, "the-code", "the-verifier", fake as unknown as typeof fetch);
    expect(sent!.get("grant_type")).toBe("authorization_code");
    expect(sent!.get("code_verifier")).toBe("the-verifier");
    expect(sent!.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", scopes: ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"] });
    expect(tokens.expiresAt.getTime()).toBeLessThan(Date.now() + 3600 * 1000);
  });

  it("a revoked grant is told apart from other failures", async () => {
    const fake = vi.fn(async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const err = await api.refreshAccessToken(CONFIG, "dead", fake as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(api.GoogleApiError);
    expect(err.code).toBe("invalid_grant");
    expect(err.needsReconnect).toBe(true);
    const busy = await api.refreshAccessToken(CONFIG, "x", (async () => json({ error: "rate_limit" }, 429)) as unknown as typeof fetch).catch((e) => e);
    expect(busy.needsReconnect).toBe(false);
  });

  it("lists spreadsheets from Drive METADATA only, across every page, newest first", async () => {
    const urls: URL[] = [];
    const fake = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return url.searchParams.get("pageToken")
        ? json({ files: Array.from({ length: 24 }, (_, i) => ({ id: `b${i}`, name: `B ${i}` })) })
        : json({ files: Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, name: `A ${i}` })), nextPageToken: "next" });
    });
    const { files, capped } = await api.listDriveSpreadsheets("token", fake as unknown as typeof fetch);
    expect(files).toHaveLength(1024);
    expect(capped).toBe(false);
    expect(urls).toHaveLength(2);
    expect(urls[0]!.origin + urls[0]!.pathname).toBe("https://www.googleapis.com/drive/v3/files");
    expect(urls[0]!.searchParams.get("q")).toBe("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    expect(urls[0]!.searchParams.get("orderBy")).toBe("modifiedTime desc");
    // File details only: nothing from inside a sheet, and not even the sharing list.
    const fields = urls[0]!.searchParams.get("fields")!;
    expect(fields).toBe(api.DRIVE_SPREADSHEET_FIELDS);
    for (const forbidden of ["permissions", "exportLinks", "contentHints", "thumbnailLink", "description"]) expect(fields).not.toContain(forbidden);
  });

  it("reads each file's details, and keeps a link only when it points at Google", async () => {
    const fake = async () =>
      json({
        files: [
          {
            id: "sheet-1",
            name: "  Daily Client Follow-up ",
            modifiedTime: "2026-10-08T10:15:00.000Z",
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
            shared: true,
            owners: [{ displayName: "Rudra", emailAddress: "Rudra@Example.com" }],
            lastModifyingUser: { displayName: "Borhan" },
            capabilities: { canEdit: true, canShare: false },
          },
          { id: "sheet-2", webViewLink: "javascript:alert(1)", modifiedTime: "not a date" },
          { name: "no id — ignored" },
        ],
      });
    const { files } = await api.listDriveSpreadsheets("token", fake as unknown as typeof fetch);
    expect(files).toEqual([
      {
        id: "sheet-1",
        name: "Daily Client Follow-up",
        modifiedTime: new Date("2026-10-08T10:15:00.000Z"),
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        shared: true,
        ownerName: "Rudra",
        ownerEmail: "rudra@example.com",
        lastModifiedByName: "Borhan",
        // Google leaves the email out when the person has not made it visible: never guessed.
        lastModifiedByEmail: null,
        canEdit: true,
        canShare: false,
      },
      {
        id: "sheet-2",
        name: "Untitled spreadsheet",
        modifiedTime: null,
        webViewLink: null,
        shared: false,
        ownerName: null,
        ownerEmail: null,
        lastModifiedByName: null,
        lastModifiedByEmail: null,
        canEdit: false,
        canShare: false,
      },
    ]);
    expect(api.safeGoogleLink("https://evil.example/google.com")).toBeNull();
    expect(api.safeGoogleLink("http://docs.google.com/x")).toBeNull();
    expect(api.safeGoogleLink("https://docs.google.com.evil.example/x")).toBeNull();
  });

  it("stops at the cap and says the list is incomplete", async () => {
    let page = 0;
    const fake = async () => {
      page += 1;
      return json({ files: Array.from({ length: 1000 }, (_, i) => ({ id: `p${page}-${i}` })), nextPageToken: `t${page}` });
    };
    const { files, capped } = await api.listDriveSpreadsheets("token", fake as unknown as typeof fetch);
    expect(capped).toBe(true);
    expect(files).toHaveLength(api.SPREADSHEET_LIST_CAP);
  });

  it("revoking never throws", async () => {
    expect(await api.revokeToken("t", (async () => json({}, 400)) as unknown as typeof fetch)).toBe(false);
    expect(await api.revokeToken("t", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
  });
});
