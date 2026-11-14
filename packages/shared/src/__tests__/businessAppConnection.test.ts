import { describe, expect, it } from "vitest";
import { isSupportedAppContract, LAUNCH_TICKET_MAX_LIFETIME_MS, parseApprovedAppUrl, safeAppPath, validateLaunchTicket } from "../businessApps.js";

/** The rules every real Business App connection passes before anything is called, framed or followed. */
describe("Business App connection rules", () => {
  it("activates only a contract version the host has an adapter for, exactly", () => {
    expect(isSupportedAppContract("commerce", "v1")).toBe(true);
    for (const v of ["V1", "v2", "1", " v1", "", null, undefined, 1]) expect(isSupportedAppContract("commerce", v), String(v)).toBe(false);
    expect(isSupportedAppContract("education", "v1")).toBe(false);
  });

  it("talks only to HTTPS addresses, or plain HTTP on this machine, and never to one carrying credentials or state", () => {
    expect(parseApprovedAppUrl("https://commerce.example.com/api")?.href).toBe("https://commerce.example.com/api");
    expect(parseApprovedAppUrl("http://localhost:5262")?.origin).toBe("http://localhost:5262");
    expect(parseApprovedAppUrl("http://127.0.0.1:5262")?.origin).toBe("http://127.0.0.1:5262");
    for (const bad of ["http://commerce.example.com", "http://10.0.0.5:5250", "ftp://x.test", "https://u:p@x.test", "https://x.test/?k=1", "https://x.test/#a", "javascript:alert(1)", "", "  ", null]) {
      expect(parseApprovedAppUrl(bad), String(bad)).toBeNull();
    }
  });

  it("follows a launch hand-off only on the approved origin, secure, and expiring soon but not yet", () => {
    const now = new Date("2026-11-14T10:00:00Z");
    const soon = new Date(now.getTime() + 60_000).toISOString();
    const ok = validateLaunchTicket({ redirectUrl: "https://shop.example.com/sso?code=x", expiresAt: soon }, "https://shop.example.com", now);
    expect(ok.ok).toBe(true);
    const refusal = (redirectUrl: string, expiresAt = soon) => {
      const r = validateLaunchTicket({ redirectUrl, expiresAt }, "https://shop.example.com", now);
      return r.ok ? null : r.refusal;
    };
    expect(refusal("http://shop.example.com/sso")).toBe("NOT_SECURE");
    expect(refusal("https://shop.example.com.evil.test/sso")).toBe("WRONG_ORIGIN");
    expect(refusal("https://shop.example.com:8443/sso")).toBe("WRONG_ORIGIN");
    expect(refusal("https://user:pw@shop.example.com/sso")).toBe("INVALID_URL");
    expect(refusal("not a url")).toBe("INVALID_URL");
    expect(refusal("https://shop.example.com/sso", now.toISOString())).toBe("EXPIRED");
    expect(refusal("https://shop.example.com/sso", "tomorrow")).toBe("EXPIRED");
    expect(refusal("https://shop.example.com/sso", new Date(now.getTime() + LAUNCH_TICKET_MAX_LIFETIME_MS + 1).toISOString())).toBe("TOO_LONG_LIVED");
  });

  it("opens only a path inside the embedded app, never another address", () => {
    expect(safeAppPath("/orders?status=open")).toBe("/orders?status=open");
    expect(safeAppPath(undefined)).toBe("/dashboard");
    for (const bad of ["//evil.test", "https://evil.test", "\\\\evil.test", "/\\evil.test", "orders", "/a\nb", "/" + "x".repeat(400)]) expect(safeAppPath(bad), bad).toBe("/dashboard");
  });
});
