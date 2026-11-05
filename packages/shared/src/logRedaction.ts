/**
 * The last line of defence for what is written to logs: stdout and System Logs
 * (docs/get-assist-ultimate/20, O1 and its review R1–R6).
 *
 * Log calls are written to carry ids, counts and decisions only, and the worker's logPrivacy.test.ts checks
 * the source for that. But much of what is logged is not written by this code: an error's message and
 * stack come from WhatsApp Web, Puppeteer, Prisma, SMTP or an AI provider, and can quote a chat id, a phone
 * number, an address or part of a key. This rewrites what such text contains by SHAPE, whatever produced it:
 *
 *   WhatsApp message ids `true_…`/`false_…`  -> [wa-msg]
 *   WhatsApp ids `…@c.us`, `@g.us`, `@lid`, `@s.whatsapp.net`, `@broadcast`, `@newsletter` -> [wa-id]
 *   email addresses                          -> [email]
 *   Bearer / Basic credentials, JWTs, sk-/pk- keys, token= / key= / signature= query values -> [secret]
 *   runs of 10–15 digits, with an optional + -> [number]
 *
 * It cannot recognise free text a customer wrote, or a secret with no recognisable shape. Keeping those
 * out of logs stays the call site's job, and the source scanner's. The digit rule also hides an
 * epoch-millisecond timestamp (13 digits); log ISO times instead, as the code already does.
 *
 * Pure (no Node or browser API), so the worker, `packages/ai-client` and the web can all use it.
 * Every direct `systemLog.create` must pass its message and metadata through it (logPrivacy.test.ts).
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
