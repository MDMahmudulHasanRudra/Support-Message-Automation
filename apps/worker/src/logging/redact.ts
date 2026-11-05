import { format } from "node:util";

/**
 * The last line of defence for what the worker writes to logs: stdout and System Logs.
 *
 * Log calls are written to carry ids, counts and decisions only, and `logPrivacy.test.ts` checks the
 * source for that. But much of what is logged is not written by this code: an error's message and stack
 * come from WhatsApp Web, Puppeteer, Prisma, SMTP or an AI provider, and can quote a chat id, a phone
 * number or an address (docs/get-assist-ultimate/20, review O1-R2/R4). This rewrites what such text
 * contains by SHAPE, whatever produced it:
 *
 *   WhatsApp message ids `true_…`/`false_…`  -> [wa-msg]
 *   WhatsApp ids `…@c.us`, `@g.us`, `@lid`, `@s.whatsapp.net`, `@broadcast`, `@newsletter` -> [wa-id]
 *   email addresses                          -> [email]
 *   Bearer / Basic credentials, JWTs, sk-/pk- keys, token= / key= / signature= query values -> [secret]
 *   runs of 10–15 digits, with an optional + -> [number]
 *
 * It cannot recognise free text a customer wrote. Keeping that out of logs stays the call site's job,
 * and the source scanner's. The digit rule also hides an epoch-millisecond timestamp (13 digits); log
 * ISO times instead, as the code already does.
 */
const RULES: Array<[RegExp, string]> = [
  [/\b(?:true|false)_[^\s"'`,;)\]}]+/g, "[wa-msg]"],
  [/[\w.+-]*@(?:c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter)\b/g, "[wa-id]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b(?:Bearer|Basic)\s+[\w.~+/=-]+/gi, "[secret]"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[secret]"],
  [/\b(?:sk|pk|rk)[-_][\w-]{16,}/g, "[secret]"],
  [/([?&](?:access_token|token|key|api_key|apikey|signature|sig|password|secret)=)[^&\s"']+/gi, "$1[secret]"],
  [/(?<![\w.])\+?\d{10,15}(?![\w.])/g, "[number]"],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The same, through any JSON-shaped value, for System Log metadata. An Error becomes its name, its
 * redacted message and its redacted stack. Depth-limited, so a cyclic object cannot hang a log write.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[too deep]";
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), ...(value.stack ? { stack: redactText(value.stack) } : {}) };
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, depth + 1)]));
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];
const INSTALLED = Symbol.for("get-assist.console-redaction");

/**
 * Wraps the console so every line is formatted as Node would format it (util.format, the same rules
 * console uses), then redacted, then written by the original method. Covers this code's 250-odd calls,
 * every error object and stack passed to them, and anything a library prints through `console`.
 * Idempotent. Installed by the worker's first import (`installRedaction.ts`).
 */
export function installConsoleRedaction(target: Console = console): void {
  const marked = target as Console & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(redactText(format(...args)));
  }
  marked[INSTALLED] = true;
}
