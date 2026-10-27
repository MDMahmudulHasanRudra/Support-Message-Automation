import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  metaProjectAllowed,
  assetKey,
  classifyMetaAssets,
  hasPageRoleFor,
  META_OAUTH_CALLBACK_PATH,
  metaPlatformAppSecret,
  missingScopes,
  readGrantedScopes,
  readMetaPlatformConfig,
  readMetaSignedRequest,
  type DiscoveredPage,
} from "../metaPlatform.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const GOOD_ENV = {
  META_INTEGRATION_ENABLED: "true",
  META_APP_ID: "123456789012345",
  META_APP_SECRET: SECRET,
  META_WEBHOOK_VERIFY_TOKEN: "verify-token-0123456789",
};

describe("readMetaPlatformConfig", () => {
  it("reads a complete configuration and defaults the callback to NEXTAUTH_URL", () => {
    const r = readMetaPlatformConfig(GOOD_ENV, "https://app.example.com");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.redirectUri).toBe(`https://app.example.com${META_OAUTH_CALLBACK_PATH}`);
    expect(r.config.graphVersion).toBe("v25.0");
    expect(r.config.loginConfigId).toBeNull();
  });

  it("is off unless explicitly enabled, even when everything else is set", () => {
    const r = readMetaPlatformConfig({ ...GOOD_ENV, META_INTEGRATION_ENABLED: "1" }, "https://app.example.com");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.enabled).toBe(false);
  });

  it("names every problem by variable and never echoes a value", () => {
    const r = readMetaPlatformConfig({ META_INTEGRATION_ENABLED: "true", META_APP_ID: "abc", META_APP_SECRET: "not-a-secret-value", META_WEBHOOK_VERIFY_TOKEN: "short", META_GRAPH_API_VERSION: "25", META_OAUTH_REDIRECT_URI: "http://evil.example.com/api/meta/oauth/callback?x=1" }, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.problems.join(" ");
    for (const name of ["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "META_GRAPH_API_VERSION", "META_OAUTH_REDIRECT_URI"]) expect(text).toContain(name);
    expect(text).not.toContain("not-a-secret-value");
    expect(text).toContain("https://");
  });

  it("refuses a redirect URI on another path, and allows http only on localhost", () => {
    expect(readMetaPlatformConfig({ ...GOOD_ENV, META_OAUTH_REDIRECT_URI: "https://app.example.com/somewhere" }, null).ok).toBe(false);
    expect(readMetaPlatformConfig({ ...GOOD_ENV, META_OAUTH_REDIRECT_URI: `http://localhost:8668${META_OAUTH_CALLBACK_PATH}` }, null).ok).toBe(true);
  });

  it("gives the worker the secret only when it is well-formed", () => {
    expect(metaPlatformAppSecret(GOOD_ENV)).toBe(SECRET);
    expect(metaPlatformAppSecret({ META_APP_SECRET: "nope" })).toBeNull();
  });
});

describe("permissions", () => {
  it("reads /me/permissions into granted and declined", () => {
    expect(readGrantedScopes({ data: [{ permission: "pages_messaging", status: "granted" }, { permission: "instagram_manage_messages", status: "declined" }, { nonsense: 1 }] })).toEqual({
      granted: ["pages_messaging"],
      declined: ["instagram_manage_messages"],
    });
  });
  it("names what a channel still needs", () => {
    expect(missingScopes("MESSENGER", ["pages_show_list", "pages_manage_metadata"])).toEqual(["pages_messaging"]);
    expect(missingScopes("INSTAGRAM", ["pages_show_list", "pages_manage_metadata", "instagram_basic", "instagram_manage_messages"])).toEqual([]);
  });
  it("needs a role that can both message and subscribe the Page", () => {
    expect(hasPageRoleFor(["MESSAGING", "MODERATE"])).toBe(true);
    expect(hasPageRoleFor(["MANAGE"])).toBe(true);
    expect(hasPageRoleFor(["MESSAGING"])).toBe(false);
    expect(hasPageRoleFor(["ANALYZE", "CREATE_CONTENT"])).toBe(false);
  });
});

describe("classifyMetaAssets", () => {
  const ALL = ["pages_show_list", "pages_manage_metadata", "pages_messaging", "instagram_basic", "instagram_manage_messages"];
  const page = (id: string, ig: DiscoveredPage["instagram"] = null, tasks = ["MANAGE", "MESSAGING", "MODERATE"]): DiscoveredPage => ({ id, name: `Page ${id}`, tasks, instagram: ig });

  it("offers Messenger and Instagram for each Page with the right verdict", () => {
    const out = classifyMetaAssets({
      pages: [page("1", { id: "ig1", username: "shop", name: "Shop" }), page("2"), page("3", null, ["ANALYZE"])],
      grantedScopes: ALL,
      here: new Map([[assetKey("MESSENGER", "1"), "PLATFORM" as const]]),
      elsewhere: new Set([assetKey("INSTAGRAM", "ig1")]),
    });
    const verdict = Object.fromEntries(out.map((a) => [a.key, a.availability]));
    expect(verdict).toEqual({
      "MESSENGER:1": "CONNECTED_HERE",
      "INSTAGRAM:ig1": "CONNECTED_ELSEWHERE",
      "MESSENGER:2": "AVAILABLE",
      "INSTAGRAM:page:2": "NO_INSTAGRAM",
      "MESSENGER:3": "MISSING_PAGE_ROLE",
      "INSTAGRAM:page:3": "NO_INSTAGRAM",
    });
    expect(out.filter((a) => a.selectable).map((a) => a.key)).toEqual(["MESSENGER:1", "MESSENGER:2"]);
    // Another workspace is never named.
    expect(out.find((a) => a.availability === "CONNECTED_ELSEWHERE")?.reason).not.toMatch(/proj|workspace [A-Z]/);
  });

  it("refuses everything for a channel whose permission was declined", () => {
    const out = classifyMetaAssets({ pages: [page("1", { id: "ig1", username: null, name: null })], grantedScopes: ["pages_show_list", "pages_manage_metadata", "pages_messaging"], here: new Map(), elsewhere: new Set() });
    expect(out.find((a) => a.type === "INSTAGRAM")?.availability).toBe("MISSING_PERMISSION");
    expect(out.find((a) => a.type === "MESSENGER")?.availability).toBe("AVAILABLE");
  });

  it("offers a manually connected account for switching to one-click", () => {
    const out = classifyMetaAssets({ pages: [page("1")], grantedScopes: ALL, here: new Map([[assetKey("MESSENGER", "1"), "MANUAL" as const]]), elsewhere: new Set() });
    expect(out[0]).toMatchObject({ availability: "MANUAL_HERE", selectable: true });
  });
});

describe("readMetaSignedRequest", () => {
  const sign = (payload: object, secret = SECRET) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    return `${sig}.${body}`;
  };
  it("returns the user id of a correctly signed request", () => {
    expect(readMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "4242", issued_at: 1700000000 }), SECRET)).toEqual({ userId: "4242", issuedAt: 1700000000 });
  });
  it("refuses a wrong secret, a tampered payload, another algorithm and garbage", () => {
    const good = sign({ algorithm: "HMAC-SHA256", user_id: "4242" });
    expect(readMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "4242" }, "f".repeat(32)), SECRET)).toBeNull();
    const [sig] = good.split(".");
    expect(readMetaSignedRequest(`${sig}.${Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "9999" })).toString("base64url")}`, SECRET)).toBeNull();
    expect(readMetaSignedRequest(sign({ algorithm: "none", user_id: "4242" }), SECRET)).toBeNull();
    expect(readMetaSignedRequest("not-a-request", SECRET)).toBeNull();
    expect(readMetaSignedRequest(null, SECRET)).toBeNull();
  });
});

describe("metaProjectAllowed (META_ALLOWED_PROJECT_IDS)", () => {
  it("fails closed: unset, empty or blank allows no workspace", () => {
    expect(metaProjectAllowed({}, "p1")).toBe(false);
    expect(metaProjectAllowed({ META_ALLOWED_PROJECT_IDS: "" }, "p1")).toBe(false);
    expect(metaProjectAllowed({ META_ALLOWED_PROJECT_IDS: "  ,  " }, "p1")).toBe(false);
  });
  it("allows exactly the listed ids, comma- or space-separated, and never a missing id", () => {
    const env = { META_ALLOWED_PROJECT_IDS: " p1, p2  p3 " };
    expect(["p1", "p2", "p3"].map((id) => metaProjectAllowed(env, id))).toEqual([true, true, true]);
    expect(metaProjectAllowed(env, "p")).toBe(false);
    expect(metaProjectAllowed(env, "p12")).toBe(false);
    expect(metaProjectAllowed(env, null)).toBe(false);
    expect(metaProjectAllowed({ META_ALLOWED_PROJECT_IDS: "*" }, undefined)).toBe(false);
  });
  it("\"*\" allows every workspace", () => {
    expect(metaProjectAllowed({ META_ALLOWED_PROJECT_IDS: "*" }, "anything")).toBe(true);
  });
});
