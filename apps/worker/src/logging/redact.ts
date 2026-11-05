import { format } from "node:util";
import { redactText } from "@support-automation/shared";

// The redaction rules live in packages/shared (logRedaction.ts) so packages/ai-client, which writes
// System Logs from inside this process, applies the same ones. Re-exported for the worker's own callers.
export { redactText, redactValue } from "@support-automation/shared";

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
