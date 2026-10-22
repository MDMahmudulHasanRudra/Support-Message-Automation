import { describe, expect, it } from "vitest";
import { decideGoogleClient, isPlausibleGoogleClientId, isPlausibleGoogleClientSecret, tokensIssuedTo } from "../googleOAuthClient.js";

/** Google Sheets §22 — which OAuth client a project uses. */

const row = (over: Partial<Parameters<typeof decideGoogleClient>[0] & object> = {}) => ({
  enabled: true,
  clientId: "123-abc.apps.googleusercontent.com",
  clientSecretCiphertext: "v2.k.iv.tag.ct",
  validationStatus: "VALID" as const,
  ...over,
});
const env = { clientId: "999-env.apps.googleusercontent.com", clientSecret: "env-secret" };

describe("decideGoogleClient", () => {
  it("switched off means no client at all — even with one saved and a server default", () => {
    expect(decideGoogleClient(row({ enabled: false }), env)).toMatchObject({ ok: false, reason: "DISABLED" });
  });
  it("the project's own client wins over the server default", () => {
    expect(decideGoogleClient(row(), env)).toMatchObject({ ok: true, source: "PROJECT", clientId: "123-abc.apps.googleusercontent.com", secretCiphertext: "v2.k.iv.tag.ct" });
    expect(decideGoogleClient(row({ validationStatus: "UNVALIDATED" }), env)).toMatchObject({ ok: true, source: "PROJECT" });
  });
  it("a client Google rejected is never used, and does not silently fall back to the server default", () => {
    expect(decideGoogleClient(row({ validationStatus: "INVALID" }), env)).toMatchObject({ ok: false, reason: "INVALID" });
  });
  it("without its own client a project uses the server default, else is not configured", () => {
    expect(decideGoogleClient(null, env)).toMatchObject({ ok: true, source: "ENVIRONMENT", clientId: env.clientId, secret: "env-secret" });
    expect(decideGoogleClient(row({ clientId: null, clientSecretCiphertext: null }), env)).toMatchObject({ ok: true, source: "ENVIRONMENT" });
    expect(decideGoogleClient(null, {})).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" });
    expect(decideGoogleClient(null, { clientId: " ", clientSecret: "x" })).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" });
  });
});

describe("tokensIssuedTo", () => {
  it("tokens work only with the client that issued them; an account from before is the environment's", () => {
    expect(tokensIssuedTo({ oauthClientId: "a" }, "a", "e")).toBe(true);
    expect(tokensIssuedTo({ oauthClientId: "a" }, "b", "e")).toBe(false);
    expect(tokensIssuedTo({ oauthClientId: null }, "e", "e")).toBe(true);
    expect(tokensIssuedTo({ oauthClientId: null }, "b", "e")).toBe(false);
    expect(tokensIssuedTo({ oauthClientId: null }, "b", null)).toBe(true);
  });
});

describe("input shapes", () => {
  it("recognises a Google client ID and a plausible secret", () => {
    expect(isPlausibleGoogleClientId("1234-abcd.apps.googleusercontent.com")).toBe(true);
    expect(isPlausibleGoogleClientId("GOCSPX-abc")).toBe(false);
    expect(isPlausibleGoogleClientSecret("GOCSPX-abcdefghijk")).toBe(true);
    expect(isPlausibleGoogleClientSecret("short")).toBe(false);
    expect(isPlausibleGoogleClientSecret("has space inside")).toBe(false);
  });
});
