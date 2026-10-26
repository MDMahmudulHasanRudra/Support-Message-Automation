import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The automated-reply disclosure is a Facebook Messenger / Instagram DM feature
 * (docs/meta-integration/08-ai-disclosure.md), and must not be able to change WhatsApp, Telegram or any
 * other AI module. This pins that STRUCTURALLY: exactly one file in the worker may use the disclosure
 * helpers — the Meta channel AI path — and the WhatsApp AI fallback, pipeline, rule engine wiring and
 * outbound queue mention none of it. A later change that wires disclosure into WhatsApp fails here
 * before it can ship. (The behaviour itself is pinned by channels.integration.test.ts, and WhatsApp's
 * by its own unchanged suites: aiFallback*, pipeline*, outboundQueue*.)
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCLOSURE = /aiDisclos|AiDisclos|withAiDisclosure|DEFAULT_AI_DISCLOSURE/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...sources(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the AI disclosure stays inside the Meta channel AI path", () => {
  const files = sources(SRC);
  const users = files.filter((f) => DISCLOSURE.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f).replace(/\\/g, "/"));

  it("is used by exactly one worker file: channels/aiReply.ts", () => {
    expect(users).toEqual(["channels/aiReply.ts"]);
  });

  it("is applied there only behind the explicit Messenger / Instagram check", () => {
    const aiReply = fs.readFileSync(path.join(SRC, "channels", "aiReply.ts"), "utf8");
    expect(aiReply).toMatch(/const disclosure = isAiDisclosureChannel\(type\) \? await disclosureFor\(message\) : null;/);
  });

  it("never reaches WhatsApp's AI fallback, pipeline, outbound queue or Telegram code", () => {
    const whatsapp = files
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
      .filter((f) => /^(aiFallback|pipeline|queue|provider|notifications|escalation|supportActivity|supportResponse|supportAssignment|mood)\//.test(f));
    expect(whatsapp.length).toBeGreaterThan(20);
    for (const f of whatsapp) expect(DISCLOSURE.test(fs.readFileSync(path.join(SRC, f), "utf8")), f).toBe(false);
  });
});
