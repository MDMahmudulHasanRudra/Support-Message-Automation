import { describe, expect, it } from "vitest";
import { classifyMetaPublishError, classifyMetaSocialAccounts, igQuotaAllows, META_SOCIAL_SCOPES, missingSocialScopes, readIgContainerStatus } from "./socialMeta.js";
import { META_REQUESTED_SCOPES } from "./metaPlatform.js";

const ALL = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];
const TOKEN = "PAGE_TOKEN_abcdefghijklmnopqrstuvwxyz";

describe("publishing permissions are separate from messaging", () => {
  it("asks for publishing scopes and never the messaging ones", () => {
    expect(META_SOCIAL_SCOPES).toContain("pages_manage_posts");
    expect(META_SOCIAL_SCOPES).toContain("instagram_content_publish");
    expect(META_SOCIAL_SCOPES).not.toContain("pages_messaging");
    expect(META_SOCIAL_SCOPES).not.toContain("instagram_manage_messages");
    // A messaging grant alone never makes an account publishable.
    expect(missingSocialScopes("FACEBOOK_PAGE", META_REQUESTED_SCOPES)).toContain("pages_manage_posts");
  });
});

describe("account discovery", () => {
  it("makes a Page and its Instagram account publishable only with the role and the permissions", () => {
    const rows = [{ id: "p1", name: "Shop", tasks: ["CREATE_CONTENT"], access_token: TOKEN, instagram_business_account: { id: "ig1", username: "shop" } }];
    const ok = classifyMetaSocialAccounts(rows, ALL);
    expect(ok.map((a) => [a.platform, a.status])).toEqual([
      ["FACEBOOK_PAGE", "ACTIVE"],
      ["INSTAGRAM", "ACTIVE"],
    ]);
    expect(ok[1]!.parentExternalId).toBe("p1");
    const noIg = classifyMetaSocialAccounts(rows, ALL.filter((s) => s !== "instagram_content_publish"));
    expect(noIg.map((a) => a.status)).toEqual(["ACTIVE", "NEEDS_RECONNECT"]);
    const noRole = classifyMetaSocialAccounts([{ ...rows[0]!, tasks: ["ANALYZE"] }], ALL);
    expect(noRole.every((a) => a.status === "NEEDS_RECONNECT")).toBe(true);
  });
});

describe("reading Graph's answers", () => {
  it("classifies publishing errors, and an ambiguous one depends on whether the request left", () => {
    expect(classifyMetaPublishError(400, { error: { code: 190 } }, true).kind).toBe("AUTH");
    expect(classifyMetaPublishError(400, { error: { code: 32 } }, true)).toMatchObject({ kind: "RETRY_LATER", rateLimited: true });
    expect(classifyMetaPublishError(400, { error: { code: 9, error_subcode: 2207042 } }, true)).toMatchObject({ kind: "RETRY_LATER", rateLimited: true });
    expect(classifyMetaPublishError(500, {}, true).kind).toBe("UNKNOWN");
    expect(classifyMetaPublishError(500, {}, false).kind).toBe("RETRY_LATER");
    expect(classifyMetaPublishError(400, { error: { code: 200, message: "Permissions error" } }, true).kind).toBe("REFUSED");
    expect(classifyMetaPublishError(400, { error: { code: 100, message: "bad access_token=EAAsecret12345678901234567890" } }, true)).toMatchObject({ kind: "REFUSED" });
    expect(JSON.stringify(classifyMetaPublishError(400, { error: { code: 100, message: "bad access_token=EAAsecret12345678901234567890" } }, true))).not.toContain("EAAsecret");
  });
  it("reads container states and the Instagram quota", () => {
    expect(readIgContainerStatus({ status_code: "FINISHED" })).toEqual({ status: "FINISHED", detail: null });
    expect(readIgContainerStatus({ status_code: "WHATEVER" })).toBeNull();
    expect(igQuotaAllows({ data: [{ quota_usage: 99, config: { quota_total: 100 } }] })).toBe(true);
    expect(igQuotaAllows({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] })).toBe(false);
    expect(igQuotaAllows({})).toBe(true);
  });
});
