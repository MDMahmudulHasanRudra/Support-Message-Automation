import { describe, expect, it } from "vitest";
import { installConsoleRedaction, redactText, redactValue } from "../logging/redact.js";

/**
 * logging/redact.ts: what reaches stdout and System Logs is rewritten by shape, whatever produced it —
 * including error messages and stacks from WhatsApp Web, Puppeteer, Prisma or SMTP (review O1-R2, O1-R4).
 * Pure: no database, no browser.
 */

const PHONE = "8801712345678";
const GROUP_MSG = `false_${PHONE}-1600000000@g.us_3EB0C0FFEE_8801898765432@c.us`;

describe("redactText", () => {
  it.each([
    ["a WhatsApp message id", `could not read ${GROUP_MSG} now`, "could not read [wa-msg] now"],
    ["a personal chat id", `chat ${PHONE}@c.us failed`, "chat [wa-id] failed"],
    ["a group id with the creator's phone", `group ${PHONE}-1600000000@g.us`, "group [wa-id]"],
    ["a LID", "sender 123456789012345@lid", "sender [wa-id]"],
    ["a bare phone number", `call +${PHONE} please`, "call [number] please"],
    ["an email address", "550 rudra.test@example.com: no such user", "550 [email]: no such user"],
    ["a bearer token", "Authorization: Bearer abc.def-ghi_123", "Authorization: [secret]"],
    ["a JWT", "token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "token [secret]"],
    ["an API key", "key sk-ant-abcdefghijklmnop1234", "key [secret]"],
    ["a token in a URL", "GET /hook?access_token=XYZ123&page=2", "GET /hook?access_token=[secret]&page=2"],
  ])("removes %s", (_what: string, input: string, expected: string) => {
    expect(redactText(input)).toBe(expected);
  });

  it("keeps what an operator needs: internal ids, ISO times, short numbers, durations", () => {
    const line = "[queue] row cm3x9k2l10000abcd sent in 1834ms at 2026-11-05T06:09:13Z, attempt 2 of 20, port 4100";
    expect(redactText(line)).toBe(line);
  });
});

describe("redactValue", () => {
  it("walks metadata and turns an Error into its redacted name, message and stack", () => {
    const err = new Error(`Evaluation failed: chat ${PHONE}@c.us not found`);
    const out = redactValue({ accountId: "acc1", error: err, nested: { list: [`${PHONE}@c.us`, 3] } }) as Record<string, any>;
    expect(out.accountId).toBe("acc1");
    expect(out.error.message).toBe("Evaluation failed: chat [wa-id] not found");
    expect(out.error.stack).not.toContain(PHONE);
    expect(out.nested.list).toEqual(["[wa-id]", 3]);
  });

  it("stores no phone in OpenWA's error-state metadata (message + stack)", () => {
    const err = new Error(`Session ${PHONE}@c.us logged out`);
    const meta = redactValue({ state: "ERROR", error: err.message, stack: err.stack });
    expect(JSON.stringify(meta)).not.toContain(PHONE);
  });

  it("survives a cyclic object", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactValue(a)).not.toThrow();
  });
});

describe("installConsoleRedaction", () => {
  function fakeConsole() {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => lines.push(args.join(" "));
    const target = { log: sink, info: sink, warn: sink, error: sink, debug: sink } as unknown as Console;
    return { target, lines };
  }

  it("redacts every line, including an error object passed as an argument", () => {
    const { target, lines } = fakeConsole();
    installConsoleRedaction(target);
    target.warn("[openwa] could not read history", new Error(`no chat ${PHONE}@c.us`));
    target.log("[pipeline] %s", GROUP_MSG);
    expect(lines.join("\n")).not.toContain(PHONE);
    expect(lines[0]).toContain("[openwa] could not read history");
    expect(lines[0]).toContain("[wa-id]");
    expect(lines[1]).toBe("[pipeline] [wa-msg]");
  });

  it("installs once", () => {
    const { target, lines } = fakeConsole();
    installConsoleRedaction(target);
    installConsoleRedaction(target);
    target.log("x");
    expect(lines).toEqual(["x"]);
  });
});
