import { describe, expect, it } from "vitest";
import { classifySmtpFailure, connectionChanged, emailConnectionState, emailRetryDelayMs, headerSafe, isForbiddenSmtpAddress, isValidEmailAddress, isValidSmtpHost, validateEmailSettings } from "../clientEmail.js";

const good = { host: "smtp.example.com", port: "587", tlsMode: "STARTTLS", username: "mailer", fromName: "Support", fromAddress: "support@example.com", replyTo: "", maxPerMinute: "10", maxPerDay: "500" };

describe("addresses and hosts", () => {
  it("accepts a plain mailbox and refuses anything that could inject a header", () => {
    expect(isValidEmailAddress("a.b+c@example.co.uk")).toBe(true);
    for (const bad of ["", "no-at.example.com", "a@b", "a b@example.com", "a@example.com\r\nBcc: x@y.com", "<a@example.com>", "a@example.com,b@example.com", "A <a@example.com>"]) expect(isValidEmailAddress(bad), bad).toBe(false);
  });
  it("accepts a bare host and refuses a URL, a port or a space", () => {
    expect(isValidSmtpHost("smtp.example.com")).toBe(true);
    for (const bad of ["https://smtp.example.com", "smtp.example.com:587", "smtp example.com", "", "-bad.com"]) expect(isValidSmtpHost(bad), bad).toBe(false);
  });
  it("forbids this machine, link-local (cloud metadata) and unspecified addresses, but not a private network", () => {
    for (const bad of ["localhost", "127.0.0.1", "127.9.9.9", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) expect(isForbiddenSmtpAddress(bad), bad).toBe(true);
    for (const ok of ["10.0.0.5", "192.168.1.10", "172.16.0.2", "smtp.example.com", "8.8.8.8"]) expect(isForbiddenSmtpAddress(ok), ok).toBe(false);
  });
});

describe("validateEmailSettings", () => {
  it("accepts a complete set and normalises it", () => {
    expect(validateEmailSettings({ ...good, replyTo: " help@example.com " })).toMatchObject({ ok: true, value: { host: "smtp.example.com", port: 587, tlsMode: "STARTTLS", replyTo: "help@example.com" } });
  });
  it("names every problem in a sentence", () => {
    const r = validateEmailSettings({ ...good, host: "http://x", port: "70000", tlsMode: "NONE", username: "", fromAddress: "nope", maxPerMinute: "0", maxPerDay: "5" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBeGreaterThanOrEqual(6);
  });
  it("refuses a daily limit below the per-minute limit and a forbidden host", () => {
    expect(validateEmailSettings({ ...good, maxPerMinute: "50", maxPerDay: "10" }).ok).toBe(false);
    expect(validateEmailSettings({ ...good, host: "127.0.0.1" }).ok).toBe(false);
  });
});

describe("connection state: connected only after a test under the current settings", () => {
  const base = { host: "h", fromAddress: "a@b.co", passwordSet: true, settingsVersion: 3, verifiedVersion: null as number | null, lastTestOk: null as boolean | null };
  it("walks from not configured to connected", () => {
    expect(emailConnectionState(null)).toBe("NOT_CONFIGURED");
    expect(emailConnectionState({ ...base, passwordSet: false })).toBe("NOT_CONFIGURED");
    expect(emailConnectionState(base)).toBe("NOT_TESTED");
    expect(emailConnectionState({ ...base, lastTestOk: false })).toBe("TEST_FAILED");
    expect(emailConnectionState({ ...base, verifiedVersion: 3, lastTestOk: true })).toBe("CONNECTED");
  });
  it("returns to needs-retest when a connection setting changed after the test", () => {
    expect(emailConnectionState({ ...base, verifiedVersion: 2, lastTestOk: true })).toBe("NEEDS_RETEST");
  });
  it("knows which changes invalidate a test", () => {
    const a = { host: "h", port: 587, tlsMode: "STARTTLS", username: "u", fromAddress: "a@b.co" };
    expect(connectionChanged(a, a, false)).toBe(false);
    expect(connectionChanged(a, a, true)).toBe(true);
    for (const patch of [{ host: "x" }, { port: 465 }, { tlsMode: "TLS" }, { username: "v" }, { fromAddress: "c@d.co" }]) expect(connectionChanged(a, { ...a, ...patch }, false)).toBe(true);
  });
});

describe("classifySmtpFailure", () => {
  it("treats a refused login as AUTH", () => {
    expect(classifySmtpFailure({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 bad credentials" }).kind).toBe("AUTH");
  });
  it("treats a failure before the message body as safe to retry", () => {
    expect(classifySmtpFailure({ code: "ETIMEDOUT", command: "CONN" }).kind).toBe("NOT_SENT");
    expect(classifySmtpFailure({ code: "ECONNECTION", command: "EHLO" }).kind).toBe("NOT_SENT");
    expect(classifySmtpFailure({ code: "ETLS", command: "STARTTLS" }).kind).toBe("NOT_SENT");
  });
  it("treats a timeout or dropped connection AFTER the body was handed over as UNKNOWN, never retried", () => {
    expect(classifySmtpFailure({ code: "ETIMEDOUT", command: "DATA" }).kind).toBe("UNKNOWN");
    expect(classifySmtpFailure({ code: "ESOCKET", command: "DATA END" }).kind).toBe("UNKNOWN");
    expect(classifySmtpFailure({ code: "SOMETHING_ELSE" }).kind).toBe("UNKNOWN");
  });
  it("splits server refusals into temporary (4xx) and permanent (5xx)", () => {
    expect(classifySmtpFailure({ responseCode: 451, command: "RCPT TO", response: "451 try later" }).kind).toBe("TEMPORARY");
    expect(classifySmtpFailure({ responseCode: 550, command: "RCPT TO", response: "550 no such user" }).kind).toBe("PERMANENT");
  });
  it("keeps the server's words short", () => {
    expect(classifySmtpFailure({ responseCode: 550, response: "x".repeat(1000) }).message.length).toBeLessThan(400);
  });
});

describe("retries and header safety", () => {
  it("backs off after temporary failures and stops after five attempts", () => {
    expect([1, 2, 3, 4].map(emailRetryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(emailRetryDelayMs(5)).toBeNull();
  });
  it("removes line breaks and control characters from a header value", () => {
    expect(headerSafe("Hello\r\nBcc: a@b.co")).toBe("Hello Bcc: a@b.co");
  });
});
