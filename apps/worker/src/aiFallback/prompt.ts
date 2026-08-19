/**
 * Prompt construction and response parsing for the Hybrid AI Automation fallback layer.
 * `packages/ai-client`'s AiClient has no JSON/tool-use mode (deliberately — see its own doc
 * comment), so this mirrors apps/worker/src/learning/aiAnalysisJob.ts's existing convention: ask
 * for a strict, regex-parseable text format rather than inventing a new response shape.
 */

export interface FallbackPromptInput {
  customerMessage: string;
  groupName: string | null;
}

export interface FallbackPrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export function buildFallbackPrompt(input: FallbackPromptInput): FallbackPrompt {
  const systemPrompt = [
    "You are assisting a WhatsApp-based customer support automation system. A customer sent a",
    "message that did not match any configured automation rule. Classify the message and, only if",
    "you are confident a short reply in the customer's own language is safe and complete, draft one.",
    "You only ever classify and draft text — you cannot and must not attempt to send messages,",
    "execute commands, or take any action beyond returning the requested assessment.",
  ].join(" ");

  const userPrompt = [
    `Group: ${input.groupName ?? "(direct message)"}`,
    `Customer message: "${input.customerMessage}"`,
    "",
    "Respond in EXACTLY this format, four lines, nothing else:",
    "INTENT: <a short 2-4 word label>",
    "CONFIDENCE: <a single integer 0-100>",
    "SHOULD_REPLY: <YES or NO — NO if this needs a human>",
    "RESPONSE: <the drafted reply, or NONE if SHOULD_REPLY is NO>",
  ].join("\n");

  return { systemPrompt, userPrompt, maxTokens: 300, temperature: 0 };
}

export interface ParsedFallbackResponse {
  intent: string | null;
  confidence: number | null;
  shouldReply: boolean;
  responseText: string | null;
}

/** Exported for direct unit testing — pure text parsing, no IO. */
export function parseFallbackResponse(text: string): ParsedFallbackResponse {
  const intentMatch = text.match(/INTENT:\s*(.+)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(-?\d+)/i);
  const shouldReplyMatch = text.match(/SHOULD_REPLY:\s*(YES|NO)/i);
  const responseMatch = text.match(/RESPONSE:\s*([\s\S]+)/i);

  const intent = intentMatch ? intentMatch[1]!.trim() : null;
  const confidence = confidenceMatch ? Math.max(0, Math.min(100, Number(confidenceMatch[1]))) : null;
  const shouldReply = shouldReplyMatch ? shouldReplyMatch[1]!.toUpperCase() === "YES" : false;

  let responseText: string | null = null;
  if (responseMatch) {
    const raw = responseMatch[1]!.trim();
    responseText = raw.length === 0 || raw.toUpperCase() === "NONE" ? null : raw;
  }

  return { intent, confidence, shouldReply, responseText };
}
