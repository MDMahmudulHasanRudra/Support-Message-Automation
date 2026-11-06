import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clientAddress, FailureWindow, tooManyAttemptsMessage } from "@/server/authRateLimit";

/**
 * P1-14: failed sign-in attempts are capped per address (server/authRateLimit.ts). Before it, guessing
 * across usernames was never slowed (an unknown username recorded nothing) and the platform operators'
 * sign-in had no limit of any kind. Pure: an injected clock, no database.
 */

function windowWith(maxFailures = 3, windowMs = 60_000, maxKeys = 100) {
  let now = 1_000_000;
  const w = new FailureWindow({ maxFailures, windowMs, maxKeys }, () => now);
  return { w, advance: (ms: number) => (now += ms) };
}

describe("FailureWindow", () => {
  it("allows the configured number of failures, then refuses until the window ends", () => {
    const { w, advance } = windowWith(3, 60_000);
    expect(w.check("1.2.3.4").limited).toBe(false);
    w.recordFailure("1.2.3.4");
    w.recordFailure("1.2.3.4");
    expect(w.check("1.2.3.4").limited).toBe(false);
    const third = w.recordFailure("1.2.3.4");
    expect(third.reachedNow).toBe(true);
    expect(w.check("1.2.3.4")).toEqual({ limited: true, retryAfterSeconds: 60 });
    advance(30_000);
    expect(w.check("1.2.3.4").retryAfterSeconds).toBe(30);
    advance(30_000);
    expect(w.check("1.2.3.4").limited).toBe(false);
  });

  it("counts addresses separately", () => {
    const { w } = windowWith(1);
    w.recordFailure("1.1.1.1");
    expect(w.check("1.1.1.1").limited).toBe(true);
    expect(w.check("2.2.2.2").limited).toBe(false);
  });

  it("reports reaching the limit once, so it is logged once", () => {
    const { w } = windowWith(2);
    expect(w.recordFailure("a").reachedNow).toBe(false);
    expect(w.recordFailure("a").reachedNow).toBe(true);
    expect(w.recordFailure("a").reachedNow).toBe(false);
  });

  it("never remembers more addresses than allowed, so spoofed addresses cannot exhaust memory", () => {
    const { w } = windowWith(5, 60_000, 50);
    for (let i = 0; i < 1000; i++) w.recordFailure(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    expect(w.size).toBeLessThanOrEqual(50);
  });
});

describe("clientAddress and the message", () => {
  it("reads the first forwarded address, then x-real-ip, then 'unknown'", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("tells the person how long to wait, and nothing about any account", () => {
    expect(tooManyAttemptsMessage(61)).toBe("Too many failed sign-in attempts from this network. Try again in 2 minutes.");
    expect(tooManyAttemptsMessage(5)).toMatch(/1 minute\.$/);
  });
});

describe("both sign-ins use it (source)", () => {
  const login = readFileSync(resolve(__dirname, "../app/(auth)/login/actions.ts"), "utf8");
  const platform = readFileSync(resolve(__dirname, "../app/platform/login/actions.ts"), "utf8");

  it("customer sign-in checks the address before looking the user up, and counts unknown users, wrong passwords and wrong codes", () => {
    expect(login.indexOf("userSignInFailures.check(")).toBeGreaterThan(-1);
    expect(login.indexOf("userSignInFailures.check(")).toBeLessThan(login.indexOf("prisma.user.findUnique"));
    // unknown user, wrong password, wrong two-step code
    expect(login.match(/countFailedSignIn\(address\)/g)?.length).toBe(3);
  });

  it("platform sign-in checks the address before looking the operator up, and counts every failure", () => {
    expect(platform.indexOf("platformSignInFailures.check(")).toBeGreaterThan(-1);
    expect(platform.indexOf("platformSignInFailures.check(")).toBeLessThan(platform.indexOf("platformOperator.findUnique"));
    expect(platform).toMatch(/platformSignInFailures\.recordFailure\(address\)/);
  });
});
