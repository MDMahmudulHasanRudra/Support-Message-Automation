import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { deriveTraceKey, logRef, messageTraceId, messageTraceIdWithKey } from "../logging/logRef.js";

/**
 * Logs carry ids, counts, durations and decisions — never what a customer wrote or who they are
 * (docs/get-assist-ultimate/20-logging-and-observability-plan.md, O1, and its review O1-R1..R5).
 *
 * Until 5 Nov 2026 the pipeline wrote, for EVERY incoming message, the sender's phone, the chat id and the
 * first 80 characters of the text to stdout, and Docker kept it with no rotation. WhatsApp's own ids are
 * not opaque either: a message id is `<fromMe>_<chat>_<id>[_<participant>]` and a personal chat id is
 * `<phone>@c.us`, so printing one prints a phone number. `logRef()` / `messageTraceId()` are how such ids
 * are referred to; logging/redact.ts rewrites what still slips through inside library error text.
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

/** Every console.x(…), traceStage(…) and logSystemEvent(…) call, from its name to its balanced closing paren. */
function logCalls(source: string): string[] {
  const calls: string[] = [];
  const start = /\b(console\.(?:log|info|warn|error|debug)|traceStage|logSystemEvent)\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    const before = source.slice(Math.max(0, m.index - 16), m.index);
    if (/function\s+$/.test(before) || /async\s+function\s+$/.test(before)) continue; // the declarations themselves
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
  ["a serialised WhatsApp id", /_serialized\b/],
];

/**
 * In the provider code the objects are WhatsApp's own — a chat, a message, a contact — so their `.id`,
 * `.from`, `.to`, `.author` ARE WhatsApp ids (review O1-R1: `chat.id`, `message.id` slipped past the
 * name-based rules). Elsewhere `message.id` is a database row id and fine to log.
 */
const FORBIDDEN_IN_PROVIDER: Array<[string, RegExp]> = [
  ["a WhatsApp object's id (chat.id, message.id, …)", /\b(chat|message|msg|m|c|contact|participant|p|group|g|sender)\??\.(id|from|to|author|chatId)\b/],
  // `(message as { id?: unknown })?.id` — the same id behind a cast (review O1-R1, the line-2114 case).
  ["a WhatsApp object's id behind a cast", /\)\??\.(id|from|to|author)\b/],
];

/** Removes every `logRef(…)` / `messageTraceId(…)` call, however deeply its argument nests. */
function stripReferences(call: string): string {
  let out = "";
  const start = /\b(logRef|messageTraceId)\(/g;
  let from = 0;
  for (let m = start.exec(call); m; m = start.exec(call)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < call.length; i++) {
      if (call[i] === "(") depth++;
      else if (call[i] === ")" && --depth === 0) break;
    }
    out += call.slice(from, m.index) + `${m[1]}(…)`;
    from = i + 1;
    start.lastIndex = from;
  }
  return out + call.slice(from);
}

function findingsIn(file: string, source: string): string[] {
  const inProvider = relative(SRC, file).split(sep)[0] === "provider";
  const rules = inProvider ? [...FORBIDDEN, ...FORBIDDEN_IN_PROVIDER] : FORBIDDEN;
  return logCalls(source).flatMap((call) => {
    const checked = stripReferences(call);
    return rules
      .filter(([, re]) => re.test(checked))
      .map(([what]) => `${relative(SRC, file)}: ${what} in ${call.replace(/\s+/g, " ").slice(0, 140)}`);
  });
}

const files = sourceFiles(SRC);
const findings = files.flatMap((file) => findingsIn(file, readFileSync(file, "utf8")));

describe("worker logs never print customer data", () => {
  it("finds log calls to check (the scanner itself works)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((f) => logCalls(readFileSync(f, "utf8"))).length).toBeGreaterThan(300);
  });

  it("no console.*, traceStage or logSystemEvent call prints message text, a phone number, a WhatsApp id or a customer's name", () => {
    expect(findings).toEqual([]);
  });

  it("catches what the review found: property access on WhatsApp objects in the provider", () => {
    const fake = join(SRC, "provider", "fake.ts");
    expect(findingsIn(fake, "console.warn(`could not read history for chat ${chat.id}`, err);")).toHaveLength(1);
    expect(findingsIn(fake, "console.error(`bad message ${message?.id}`);")).toHaveLength(1);
    expect(findingsIn(fake, 'console.error(`bad ${String((message as { id?: unknown })?.id ?? "unknown")}`, err);')).toHaveLength(1);
    expect(findingsIn(fake, 'console.error(`bad ${logRef(String((message as { id?: unknown })?.id ?? "unknown"))}`, err);')).toEqual([]);
    expect(findingsIn(fake, "console.warn(`could not read history for chat ${logRef(String(chat.id))}`, err);")).toEqual([]);
    // Outside the provider, message.id is a database row id.
    expect(findingsIn(join(SRC, "pipeline", "fake.ts"), 'traceStage(traceId, "MESSAGE_PERSISTED", { messageId: message.id });')).toEqual([]);
  });

  it("the pipeline trace id is a reference, not the raw WhatsApp message id", () => {
    const pipeline = readFileSync(join(SRC, "pipeline/processIncomingMessage.ts"), "utf8");
    expect(pipeline).not.toMatch(/traceId\s*=\s*`\$\{raw\.accountId\}:\$\{raw\.whatsappMessageId\}`/);
    expect(pipeline).toMatch(/traceId\s*=\s*messageTraceId\(/);
  });

  it("the worker installs console redaction before any other import (review O1-R2)", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const firstImport = index.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toMatch(/^import "\.\/logging\/installRedaction\.js";/);
  });

  it("System Log writers redact what they store (review O1-R4)", () => {
    expect(readFileSync(join(SRC, "logging/logSystemEvent.ts"), "utf8")).toMatch(/metadata: redactValue\(metadata\)/);
    expect(readFileSync(join(SRC, "provider/openwa/connectionState.ts"), "utf8")).toMatch(/metadata: redactValue\(/);
  });
});

describe("logRef and messageTraceId", () => {
  const groupMessageId = "false_8801712345678-1600000000@g.us_3EB0C0FFEE_8801898765432@c.us";
  const PII = ["8801712345678", "8801898765432", "@g.us", "@c.us", "3EB0C0FFEE"];

  it("logRef is stable within a process and tells different ids apart", () => {
    expect(logRef(groupMessageId)).toBe(logRef(groupMessageId));
    expect(logRef(groupMessageId)).not.toBe(logRef(`${groupMessageId}x`));
  });

  it("logRef carries none of the input", () => {
    const ref = logRef(groupMessageId);
    expect(ref).toMatch(/^r[0-9a-f]{12}$/);
    for (const part of PII) expect(ref).not.toContain(part);
  });

  it("a message's trace id is keyed: the same secret gives the same id in every process, another secret a different one (O1-R5)", () => {
    const a = messageTraceIdWithKey(deriveTraceKey("secret-one"), "acc1", groupMessageId);
    expect(messageTraceIdWithKey(deriveTraceKey("secret-one"), "acc1", groupMessageId)).toBe(a);
    expect(messageTraceIdWithKey(deriveTraceKey("secret-two"), "acc1", groupMessageId)).not.toBe(a);
    expect(messageTraceIdWithKey(deriveTraceKey("secret-one"), "acc2", groupMessageId)).not.toBe(a);
    expect(a).toMatch(/^m[0-9a-f]{16}$/);
    for (const part of PII) expect(a).not.toContain(part);
  });

  it("the worker's trace id uses the persistent secret when it is set", () => {
    expect(messageTraceId("acc1", groupMessageId)).toBe(messageTraceId("acc1", groupMessageId));
    const secret = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
    if (secret) {
      expect(messageTraceId("acc1", groupMessageId)).toBe(messageTraceIdWithKey(deriveTraceKey(secret), "acc1", groupMessageId));
    }
  });
});
