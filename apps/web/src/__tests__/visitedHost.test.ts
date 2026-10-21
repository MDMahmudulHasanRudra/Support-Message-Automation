import { describe, expect, it } from "vitest";
import { visitedHost } from "@/lib/projectPaths";

/**
 * The host every SaaS rule is decided on (SAAS_PLATFORM_PLAN.md §11, Phase 4). Next renders a Server
 * Action's redirect target through a request from the server to itself (`Host: localhost`) carrying
 * the visitor's `x-forwarded-host`; reading `Host` made that render look like localhost, so a session
 * bound to the real address read as signed out and every sign-in on a named address bounced to /login.
 */
describe("visitedHost", () => {
  it("prefers x-forwarded-host: the visitor's address in Next's own re-render after an action redirect", () => {
    expect(visitedHost(new Headers({ host: "localhost", "x-forwarded-host": "bizify.udboy.com" }))).toBe("bizify.udboy.com");
  });
  it("takes the first value of a list, lower-cased", () => {
    expect(visitedHost(new Headers({ host: "localhost", "x-forwarded-host": "Admin.Udboy.com, 10.0.0.1" }))).toBe("admin.udboy.com");
  });
  it("falls back to Host when nothing is in front", () => {
    expect(visitedHost(new Headers({ host: "zoventio.udboy.com" }))).toBe("zoventio.udboy.com");
    expect(visitedHost(new Headers())).toBe("");
  });
});
