import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { logRef, messageTraceId } from "../logging/logRef.js";

/**
 * Logs carry ids, counts, durations and decisions — never what a customer wrote or who they are
 * (docs/get-assist-ultimate/20-logging-and-observability-plan.md, O1).
 *
 * Until 5 Nov 2026 the pipeline wrote, for EVERY incoming message, the sender's phone, the chat id and the
 * first 80 characters of the text to stdout, and Docker kept it with no rotation. WhatsApp's own ids are
 * not opaque either: a message id is `<fromMe>_<chat>_<id>[_<participant>]` and a personal chat id is
 * `<phone>@c.us`, so printing one prints a phone number. `logRef()` is how such an id is referred to.
 *
 * Asserted against the SOURCE, like connectTimeouts / rawSqlProjectFilter: what is protected is what the
 * code is allowed to print, on every path, including the ones no integration test reaches. Pure: no
 * database, no browser.
 */

const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Every `console.x(...)` and `traceStage(...)` call, from its name to its balanced closing paren. */
function logCalls(source: string): string[] {
  const calls: string[] = [];
  const start = /\b(console\.(?:log|info|warn|error|debug)|traceStage)\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    if (source.slice(m.index - 9, m.index) === "function ") continue; // traceStage's own declaration
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(m.index, i + 1));
  }
  return calls;
}

/**
 * What a log call must not contain. Each is a way customer data has reached, or could reach, a log line:
 * the text itself, a phone number, a WhatsApp id that embeds one, or a name a customer chose. A raw
 * WhatsApp id inside `logRef(...)` or `messageTraceId(...)` is fine, so those are removed before checking.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["message text", /\b(raw|message|msg|m)\.body\b|bodyPreview|\.body\.slice/],
  ["a sender's phone, id or name", /\bsender(Phone|Jid|Name)\b/],
  ["a WhatsApp chat id", /\bchatId\b/],
  ["a WhatsApp message id", /\bwhatsappMessageId\b/],
  ["a WhatsApp group id (old ones embed the creator's phone)", /\bwhatsappGroupId\b/],
  ["a group's name", /\bgroupName\b/],
];

const files = sourceFiles(SRC);
const findings = files.flatMap((file) =>
  logCalls(readFileSync(file, "utf8")).flatMap((call) => {
    const checked = call.replace(/\b(logRef|messageTraceId)\([^()]*\)/g, "$1(…)");
    return FORBIDDEN.filter(([, re]) => re.test(checked)).map(
      ([what]) => `${relative(SRC, file)}: ${what} in ${call.replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }),
);

describe("worker logs never print customer data", () => {
  it("finds log calls to check (the scanner itself works)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((f) => logCalls(readFileSync(f, "utf8"))).length).toBeGreaterThan(200);
  });

  it("no console.* or traceStage call prints message text, a phone number, a WhatsApp id or a customer's name", () => {
    expect(findings).toEqual([]);
  });

  it("the pipeline trace id is a reference, not the raw WhatsApp message id", () => {
    const pipeline = readFileSync(join(SRC, "pipeline/processIncomingMessage.ts"), "utf8");
    expect(pipeline).not.toMatch(/traceId\s*=\s*`\$\{raw\.accountId\}:\$\{raw\.whatsappMessageId\}`/);
    expect(pipeline).toMatch(/traceId\s*=\s*messageTraceId\(/);
  });
});

describe("logRef", () => {
  const groupMessageId = "false_8801712345678-1600000000@g.us_3EB0C0FFEE_8801898765432@c.us";

  it("is stable within a process, so lines about one message can be matched", () => {
    expect(logRef(groupMessageId)).toBe(logRef(groupMessageId));
  });

  it("tells different ids apart", () => {
    expect(logRef(groupMessageId)).not.toBe(logRef(`${groupMessageId}x`));
  });

  it("a message's trace id is the same in every process, so stored correlation ids stay meaningful", () => {
    const expected = `m${createHash("sha256").update(`acc1:${groupMessageId}`).digest("hex").slice(0, 16)}`;
    expect(messageTraceId("acc1", groupMessageId)).toBe(expected);
    expect(messageTraceId("acc1", groupMessageId)).not.toBe(messageTraceId("acc2", groupMessageId));
    expect(messageTraceId("acc1", groupMessageId)).toMatch(/^m[0-9a-f]{16}$/);
    for (const part of ["8801712345678", "8801898765432", "@g.us", "3EB0C0FFEE"]) {
      expect(messageTraceId("acc1", groupMessageId)).not.toContain(part);
    }
  });

  it("carries none of the input: no phone digits, no domain", () => {
    const ref = logRef(groupMessageId);
    expect(ref).toMatch(/^r[0-9a-f]{12}$/);
    for (const part of ["8801712345678", "8801898765432", "@g.us", "@c.us", "3EB0C0FFEE"]) expect(ref).not.toContain(part);
  });
});
