import { describe, expect, it } from "vitest";
import {
  decideSocialTransition,
  decideTargetAction,
  expiredLeaseOutcome,
  matchRecentPublication,
  overallPostStatus,
  parseAccountSettings,
  planPublishAccounts,
  sniffSocialMedia,
  socialApprovalMaterial,
  socialRetryDelayMs,
  utcToZonedLocal,
  validateSchedule,
  validateSocialDraft,
  zonedDay,
  zonedLocalToUtc,
} from "./socialStudio.js";
import { countHashtags, extractHashtags, platformHas, SOCIAL_PLATFORMS, validateForPlatform } from "./socialPlatforms.js";

describe("post workflow", () => {
  it("never schedules a post whose material changed after approval", () => {
    expect(decideSocialTransition("SCHEDULE", { status: "APPROVED", approvalMatches: false }).ok).toBe(false);
    expect(decideSocialTransition("SCHEDULE", { status: "APPROVED", approvalMatches: true })).toEqual({ ok: true, next: "SCHEDULED" });
    for (const status of ["DRAFT", "IN_REVIEW", "FAILED", "PUBLISHED"] as const) {
      expect(decideSocialTransition("SCHEDULE", { status, approvalMatches: true }).ok).toBe(false);
    }
  });
  it("any edit returns the post to DRAFT, and a scheduled or unknown post cannot be edited", () => {
    expect(decideSocialTransition("EDIT", { status: "APPROVED", approvalMatches: true })).toEqual({ ok: true, next: "DRAFT" });
    for (const status of ["SCHEDULED", "UNKNOWN", "PUBLISHED", "PARTIAL"] as const) {
      expect(decideSocialTransition("EDIT", { status, approvalMatches: true }).ok).toBe(false);
    }
  });
  it("cancelling leaves a post scheduled while some account already started", () => {
    expect(decideSocialTransition("CANCEL", { status: "SCHEDULED", approvalMatches: true, startedTargets: 0 })).toEqual({ ok: true, next: "CANCELLED" });
    expect(decideSocialTransition("CANCEL", { status: "SCHEDULED", approvalMatches: true, startedTargets: 1 })).toEqual({ ok: true, next: "SCHEDULED" });
    expect(decideSocialTransition("CANCEL", { status: "PUBLISHED", approvalMatches: true }).ok).toBe(false);
  });
  it("keeps published history: only drafts and cancelled posts can be deleted", () => {
    expect(decideSocialTransition("DELETE", { status: "PUBLISHED", approvalMatches: true }).ok).toBe(false);
    expect(decideSocialTransition("DELETE", { status: "DRAFT", approvalMatches: true }).ok).toBe(true);
  });
});

describe("publish jobs", () => {
  it("never re-sends an unknown outcome without a person's confirmation", () => {
    expect(decideTargetAction("SEND_AGAIN", { status: "UNKNOWN", approvalMatches: true }).ok).toBe(false);
    expect(decideTargetAction("SEND_AGAIN", { status: "UNKNOWN", approvalMatches: true, confirmedNotPublished: true })).toEqual({ ok: true, next: "DUE" });
    expect(decideTargetAction("RETRY", { status: "UNKNOWN", approvalMatches: true }).ok).toBe(false);
    expect(decideTargetAction("RETRY", { status: "FAILED", approvalMatches: true })).toEqual({ ok: true, next: "DUE" });
    expect(decideTargetAction("RETRY", { status: "FAILED", approvalMatches: false }).ok).toBe(false);
  });
  it("an abandoned lease is retried only if the request never left", () => {
    expect(expiredLeaseOutcome(null)).toBe("REQUEUE");
    expect(expiredLeaseOutcome(new Date())).toBe("UNKNOWN");
  });
  it("derives the post's status from its jobs", () => {
    expect(overallPostStatus(["DUE", "PUBLISHED"])).toBe("SCHEDULED");
    expect(overallPostStatus(["UNKNOWN", "PUBLISHED"])).toBe("UNKNOWN");
    expect(overallPostStatus(["PUBLISHED", "PUBLISHED"])).toBe("PUBLISHED");
    expect(overallPostStatus(["PUBLISHED", "FAILED"])).toBe("PARTIAL");
    expect(overallPostStatus(["FAILED", "CANCELLED"])).toBe("FAILED");
    expect(overallPostStatus(["CANCELLED"])).toBe("CANCELLED");
  });
  it("backs off, more for a rate limit, never beyond an hour", () => {
    expect(socialRetryDelayMs(1, false)).toBe(60_000);
    expect(socialRetryDelayMs(2, false)).toBe(120_000);
    expect(socialRetryDelayMs(1, true)).toBe(15 * 60_000);
    expect(socialRetryDelayMs(20, true)).toBe(60 * 60_000);
  });
});

describe("project isolation", () => {
  const acc = (id: string, over: Partial<{ status: string; enabled: boolean }> = {}) => ({ id, platform: "FACEBOOK_PAGE", status: "ACTIVE", enabled: true, ...over });
  it("refuses the whole request when one account is not this project's or not usable", () => {
    expect(planPublishAccounts(["a", "foreign"], [acc("a")]).ok).toBe(false);
    expect(planPublishAccounts(["a"], [acc("a", { status: "NEEDS_RECONNECT" })]).ok).toBe(false);
    expect(planPublishAccounts(["a"], [acc("a", { status: "REMOVED" })]).ok).toBe(false);
    expect(planPublishAccounts(["a"], [acc("a", { enabled: false })]).ok).toBe(false);
    const ok = planPublishAccounts(["a", "b", "a"], [acc("a"), acc("b")]);
    expect(ok.ok && ok.accounts.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("drafts and approval material", () => {
  it("validates text, accounts, variants and settings", () => {
    expect(validateSocialDraft({ content: " ", accountIds: [], mediaIds: [], variants: {}, settings: {} }).map((p) => p.field)).toEqual(["content", "accounts"]);
    expect(validateSocialDraft({ content: "", accountIds: ["a"], mediaIds: [], variants: { a: "Own text" }, settings: {} })).toEqual([]);
    expect(validateSocialDraft({ content: "Hi", accountIds: ["a"], mediaIds: [], variants: {}, settings: { a: [1] } }).map((p) => p.field)).toEqual(["settings"]);
    expect(parseAccountSettings('{"type":"REELS"}')).toEqual({ ok: true, value: { type: "REELS" } });
    expect(parseAccountSettings("[1]").ok).toBe(false);
  });
  it("covers text, variants, media and settings, in a stable order", () => {
    const one = socialApprovalMaterial({ content: "Hi", accountIds: ["b", "a"], mediaIds: ["m"], variants: { a: "A" }, settings: { a: { y: 1, x: 2 } } });
    const same = socialApprovalMaterial({ content: "Hi", accountIds: ["a", "b"], mediaIds: ["m"], variants: { a: "A" }, settings: { a: { x: 2, y: 1 } } });
    expect(one).toBe(same);
    expect(socialApprovalMaterial({ content: "Hi", accountIds: ["a", "b"], mediaIds: ["m"], variants: { a: "B" }, settings: { a: { x: 2, y: 1 } } })).not.toBe(one);
    expect(socialApprovalMaterial({ content: "Hi", accountIds: ["a", "b"], mediaIds: ["m", "n"], variants: { a: "A" }, settings: { a: { x: 2, y: 1 } } })).not.toBe(one);
  });
  it("needs a time at least a minute ahead", () => {
    const now = new Date("2026-10-30T10:00:00Z");
    expect(validateSchedule("SCHEDULE", new Date("2026-10-30T10:00:30Z"), now).ok).toBe(false);
    expect(validateSchedule("SCHEDULE", new Date("2026-10-30T10:05:00Z"), now).ok).toBe(true);
    expect(validateSchedule("NOW", null, now).ok).toBe(true);
  });
});

describe("unknown outcome reconciliation", () => {
  const requestedAt = new Date("2026-10-30T10:00:00Z");
  const pub = (id: string, text: string, at: string) => ({ externalId: id, text, createdAt: new Date(at), permalink: null });
  it("matches exactly one publication with the same text around the request", () => {
    expect(matchRecentPublication({ text: "Hello  world", requestedAt }, [pub("1", "<p>hello world</p>", "2026-10-30T10:00:40Z")]).kind).toBe("MATCH");
    expect(matchRecentPublication({ text: "Hello world", requestedAt }, [pub("1", "Hello world", "2026-10-30T10:01:00Z"), pub("2", "Hello world", "2026-10-30T10:02:00Z")]).kind).toBe("SEVERAL");
    expect(matchRecentPublication({ text: "Hello world", requestedAt }, [pub("1", "Hello world", "2026-10-30T11:00:00Z")]).kind).toBe("NONE");
    expect(matchRecentPublication({ text: "Hello world", requestedAt }, [pub("1", "Hello world", "2026-10-30T10:01:00Z")], new Set(["1"])).kind).toBe("NONE");
    expect(matchRecentPublication({ text: "", requestedAt }, [pub("1", "", "2026-10-30T10:01:00Z")]).kind).toBe("NONE");
  });
});

describe("time zones", () => {
  it("reads a wall-clock time in the post's zone, and back", () => {
    expect(zonedLocalToUtc("2026-11-05T09:30", "Asia/Dhaka")?.toISOString()).toBe("2026-11-05T03:30:00.000Z");
    expect(zonedLocalToUtc("2026-07-01T09:00", "Europe/London")?.toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedLocalToUtc("2026-12-01T09:00", "Europe/London")?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(utcToZonedLocal(new Date("2026-11-05T03:30:00Z"), "Asia/Dhaka")).toBe("2026-11-05T09:30");
    expect(zonedDay(new Date("2026-11-04T19:00:00Z"), "Asia/Dhaka")).toBe("2026-11-05");
    expect(zonedLocalToUtc("2026-11-05T09:30", "Not/AZone")).toBeNull();
  });
});

describe("platform rules", () => {
  it("only Facebook Pages and Instagram are implemented", () => {
    expect(Object.values(SOCIAL_PLATFORMS).filter((p) => p.implemented).map((p) => p.key)).toEqual(["FACEBOOK_PAGE", "INSTAGRAM"]);
    expect(validateForPlatform("LINKEDIN", { text: "Hi", media: [] })).toEqual(["Publishing to LinkedIn is not available yet."]);
    expect(platformHas("INSTAGRAM", "DELETE")).toBe(false);
    expect(platformHas("FACEBOOK_PAGE", "DELETE")).toBe(true);
  });
  it("applies each platform's documented limits", () => {
    expect(validateForPlatform("INSTAGRAM", { text: "Hi", media: [] })).toContain("Instagram (professional account) needs a photo or a video.");
    expect(validateForPlatform("INSTAGRAM", { text: "Hi", media: [{ kind: "IMAGE", mimeType: "image/png", sizeBytes: 1000 }] }).join(" ")).toMatch(/does not take PNG/);
    expect(validateForPlatform("INSTAGRAM", { text: "Hi", media: [{ kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1000 }] })).toEqual([]);
    expect(validateForPlatform("FACEBOOK_PAGE", { text: "Hi", media: [] })).toEqual([]);
    expect(validateForPlatform("FACEBOOK_PAGE", { text: "Hi", media: [{ kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1 }, { kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 1 }] }).join(" ")).toMatch(/cannot be posted together/);
    expect(validateForPlatform("INSTAGRAM", { text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "), media: [{ kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: 1 }] }).join(" ")).toMatch(/30 hashtags/);
  });
  it("counts hashtags in any script", () => {
    expect(countHashtags("#Sale #অফার #sale")).toBe(3);
    expect(extractHashtags("#Sale #sale #অফার")).toEqual(["#sale", "#অফার"]);
  });
});

describe("media", () => {
  it("tells a file's type from its bytes", () => {
    expect(sniffSocialMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mimeType).toBe("image/jpeg");
    expect(sniffSocialMedia(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))?.kind).toBe("VIDEO");
    expect(sniffSocialMedia(new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]))?.mimeType).toBe("video/quicktime");
    expect(sniffSocialMedia(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});
