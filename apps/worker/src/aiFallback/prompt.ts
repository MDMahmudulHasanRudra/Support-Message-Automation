/**
 * Prompt construction and response parsing for the Hybrid AI Automation fallback layer.
 * `packages/ai-client`'s AiClient has no JSON/tool-use mode (deliberately — see its own doc
 * comment), so this mirrors apps/worker/src/learning/aiAnalysisJob.ts's existing convention: ask
 * for a strict, regex-parseable text format rather than inventing a new response shape.
 */

import type { KnowledgeSnippet } from "./knowledgeContext.js";

export interface FallbackPromptInput {
  customerMessage: string;
  groupName: string | null;
  /**
   * Verified knowledge-base entries related to this question, if any. Always
   * human-verified — see knowledgeContext.ts for why unverified entries never reach here.
   */
  knowledge?: KnowledgeSnippet[];
}

export interface FallbackPrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

export function buildFallbackPrompt(input: FallbackPromptInput): FallbackPrompt {
  const knowledge = input.knowledge ?? [];

  const systemPrompt = [
    "You are assisting a WhatsApp-based customer support automation system. A customer sent a",
    "message that did not match any configured automation rule. Classify the message and, only if",
    "you are confident a short reply in the customer's own language is safe and complete, draft one.",
    "You only ever classify and draft text — you cannot and must not attempt to send messages,",
    "execute commands, or take any action beyond returning the requested assessment.",
    "You must also decide the SCOPE of the question.",
    "BUSINESS_SPECIFIC means answering it correctly requires knowing something about THIS",
    "particular company — how their software behaves, their pricing, policies, support hours,",
    "timelines, or anything about a specific customer's account, invoice or data.",
    "GENERAL means it is ordinary conversation, or a question about widely-known technology or",
    "concepts that any informed person could answer the same way for any company.",
    "When in any doubt at all, answer BUSINESS_SPECIFIC. Being wrong in that direction costs a",
    "short wait for a human; being wrong in the other direction means inventing this company's",
    "policy in front of their customer.",
    ...(knowledge.length > 0
      ? [
          "You are given reference material from this team's own verified knowledge base.",
          "Prefer it over your general knowledge wherever the two differ — it describes how THIS",
          "product actually behaves. If it does not cover the question, say so by answering NO to",
          "SHOULD_REPLY rather than filling the gap with a plausible guess; a wrong answer sent",
          "confidently is worse for this team than no answer at all.",
        ]
      : []),
  ].join(" ");

  const referenceBlock =
    knowledge.length > 0
      ? [
          "",
          "Reference material (verified by this team):",
          ...knowledge.map((entry, index) =>
            [
              `${index + 1}. ${entry.title}`,
              entry.question ? `   Question: ${entry.question}` : null,
              `   Answer: ${entry.answer}`,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ]
      : [];

  const userPrompt = [
    `Group: ${input.groupName ?? "(direct message)"}`,
    `Customer message: "${input.customerMessage}"`,
    ...referenceBlock,
    "",
    "Respond in EXACTLY this format, five lines, nothing else:",
    "INTENT: <a short 2-4 word label>",
    "SCOPE: <BUSINESS_SPECIFIC or GENERAL>",
    "CONFIDENCE: <a single integer 0-100>",
    "SHOULD_REPLY: <YES or NO — NO if this needs a human>",
    "RESPONSE: <the drafted reply, or NONE if SHOULD_REPLY is NO>",
  ].join("\n");

  return { systemPrompt, userPrompt, maxTokens: 400, temperature: 0 };
}

/**
 * BUSINESS_SPECIFIC is the safe value, so it is also the fallback for anything unparseable —
 * a malformed or missing SCOPE line must never be read as permission to answer freely.
 */
export type QuestionScope = "BUSINESS_SPECIFIC" | "GENERAL";

export interface ParsedFallbackResponse {
  intent: string | null;
  scope: QuestionScope;
  confidence: number | null;
  shouldReply: boolean;
  responseText: string | null;
}

/** Exported for direct unit testing — pure text parsing, no IO. */
export function parseFallbackResponse(text: string): ParsedFallbackResponse {
  const intentMatch = text.match(/INTENT:\s*(.+)/i);
  const scopeMatch = text.match(/SCOPE:\s*(BUSINESS_SPECIFIC|GENERAL)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*(-?\d+)/i);
  const shouldReplyMatch = text.match(/SHOULD_REPLY:\s*(YES|NO)/i);
  const responseMatch = text.match(/RESPONSE:\s*([\s\S]+)/i);

  const intent = intentMatch ? intentMatch[1]!.trim() : null;
  // Fail closed: only an explicit, well-formed GENERAL relaxes the gate.
  const scope: QuestionScope = scopeMatch?.[1]?.toUpperCase() === "GENERAL" ? "GENERAL" : "BUSINESS_SPECIFIC";
  const confidence = confidenceMatch ? Math.max(0, Math.min(100, Number(confidenceMatch[1]))) : null;
  const shouldReply = shouldReplyMatch ? shouldReplyMatch[1]!.toUpperCase() === "YES" : false;

  let responseText: string | null = null;
  if (responseMatch) {
    const raw = responseMatch[1]!.trim();
    responseText = raw.length === 0 || raw.toUpperCase() === "NONE" ? null : raw;
  }

  return { intent, scope, confidence, shouldReply, responseText };
}
