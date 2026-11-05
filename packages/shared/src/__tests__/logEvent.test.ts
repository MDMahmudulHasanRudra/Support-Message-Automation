import { describe, expect, it } from "vitest";
import { formatLogLine, isRedactedKey } from "../logEvent.js";

/**
 * The shared logger (P1-07, docs/get-assist-ultimate/20 O3): the line format people grep, JSON on request,
 * and redaction by field name on top of redaction by shape. Pure.
 */

const AT = new Date("2026-11-05T10:00:00.000Z");

describe("formatLogLine — text (the default)", () => {
  it("keeps the [scope] prefix the incident runbook greps for", () => {
    const line = formatLogLine("info", "queue", "SENT", { outboundId: "cm1", attempt: 2, waitedMs: 1834 });
    expect(line).toBe("[queue] SENT outboundId=cm1 attempt=2 waitedMs=1834");
    expect(/\[(watchdog|registry|catch-up|openwa|queue)\]/.test(line)).toBe(true);
  });

  it("quotes values with spaces, leaves out undefined, prints null", () => {
    expect(formatLogLine("warn", "queue", "RETRY_SCHEDULED", { reason: "rate limited", skipped: undefined, messageId: null })).toBe(
      '[queue] RETRY_SCHEDULED reason="rate limited" messageId=null',
    );
  });

  it("an event with no fields is just the prefix and the event", () => {
    expect(formatLogLine("info", "pipeline", "PROJECT_NOT_OPERATING")).toBe("[pipeline] PROJECT_NOT_OPERATING");
  });
});

describe("formatLogLine — JSON (LOG_FORMAT=json)", () => {
  it("writes one object with time, level, scope, event and the fields", () => {
    expect(JSON.parse(formatLogLine("error", "notifications", "GAVE_UP", { notificationId: "n1", attempts: 5 }, "json", AT))).toEqual({
      ts: "2026-11-05T10:00:00.000Z",
      level: "error",
      scope: "notifications",
      event: "GAVE_UP",
      notificationId: "n1",
      attempts: 5,
    });
  });
});

describe("redaction", () => {
  it("writes a field whose name says it holds a person's data or a secret as [redacted]", () => {
    const line = formatLogLine("info", "x", "E", { body: "hello", senderPhone: "8801712345678", email: "a@b.co", apiKey: "k", name: "Rudra", outboundId: "cm1" });
    expect(line).toBe("[x] E body=[redacted] senderPhone=[redacted] email=[redacted] apiKey=[redacted] name=[redacted] outboundId=cm1");
  });

  it("names it does not redact are the ones carrying ids and figures", () => {
    for (const key of ["messageId", "outboundId", "accountId", "trace", "attempt", "waitedMs", "isGroup", "event", "type"]) expect(isRedactedKey(key)).toBe(false);
  });

  it("still redacts by shape when a value under an innocent name holds an id or a number", () => {
    expect(formatLogLine("info", "x", "E", { detail: "chat 8801712345678@c.us failed" })).toBe('[x] E detail="chat [wa-id] failed"');
  });
});
