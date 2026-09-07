/**
 * Prompt construction and response parsing for the Hybrid AI Automation fallback layer.
 * `packages/ai-client`'s AiClient has no JSON/tool-use mode (deliberately — see its own doc
 * comment), so this mirrors apps/worker/src/learning/aiAnalysisJob.ts's existing convention: ask
 * for a strict, regex-parseable text format rather than inventing a new response shape.
 */

import {
  AUTO_TIEBREAK_LANGUAGE,
  FALLBACK_REPLY_LANGUAGE,
  isAutoReplyLanguage,
} from "@support-automation/shared";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

export interface FallbackPromptInput {
  customerMessage: string;
  groupName: string | null;
  /**
   * How this team writes, learned from their own replies and approved by a person
   * (`CommunicationStyleProfile`). Absent whenever the feature is off, unbuilt or unapproved, in
   * which case the assistant writes exactly as it did before this existed.
   */
  styleGuidance?: string | null;
  /**
   * The language to answer in unless the customer clearly wrote in another one
   * (`AiSettings.defaultReplyLanguage`). Defaults here too, so a caller that forgets it still
   * gets the safe behaviour rather than the model's guess.
   *
   * `AUTO_REPLY_LANGUAGE` switches to mirroring the customer instead of leaning on a default —
   * see `buildLanguageRules` for why that is a different checklist rather than a different value
   * substituted into the same one.
   */
  defaultReplyLanguage?: string;
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

/**
 * The LANGUAGE half of the system prompt.
 *
 * Two checklists rather than one with a substituted value, because the two modes disagree about
 * what an ambiguous message means. With a configured language, "unsure" resolves TO that language
 * — the whole point of setting one. Under automatic detection there is no such answer, so the
 * list has to be built around reading the customer instead of leaning on a default, and the
 * ordering that makes each one work is different.
 *
 * What both share, and what must not be reordered in either: the greeting rule comes before the
 * English rule. "hello" was read as a fluent English sentence otherwise, which is the specific
 * bug that made English replies leak into Bengali conversations.
 */
function buildLanguageRules(configured: string): string[] {
  const preamble = [
    "LANGUAGE. Before drafting anything, decide which language the customer wrote in, and report it",
    "on the LANGUAGE line. Then write RESPONSE in that same language. Deciding first is the point:",
    "it stops every reply defaulting to the same language regardless of what was asked.",
    "",
  ];

  if (!isAutoReplyLanguage(configured)) {
    return [
      ...preamble,
      "Work down this list and stop at the first line that matches:",
      `1. A greeting or a single word — \"hello\", \"hi\", \"ok\", \"thanks\", \"yes\", \"please\", \"sure\"?`,
      `   ${configured}. These appear inside conversations in every language and settle nothing. A`,
      "   one-word greeting is NOT a fluent English sentence, whatever language the word comes from.",
      `2. Only a number, a link, an invoice reference, a product name or an emoji? ${configured}.`,
      // "other than Bengali" is load-bearing: Bengali IS a non-Latin script, so without it this
      // line and line 4 both claim a Bengali-script message and disagree about the answer whenever
      // the configured language is not itself Bengali script — Banglish, for instance.
      "3. Written in a non-Latin script other than Bengali — Devanagari, Arabic, Chinese, Tamil and",
      "   so on? That script's language. Answer in it.",
      `4. Bengali script? Answer in ${configured}.`,
      "5. Bengali written in Latin letters — \"bill kivabe generate korbo\", \"amar net kaj korche na\"?",
      `   That is Bengali rather than English, so answer in ${configured}.`,
      "6. A complete, fluent sentence or question in English, of several words? English.",
      `7. Anything else — mixed languages, or a message you cannot place confidently? ${configured}.`,
    ];
  }

  return [
    ...preamble,
    "Automatic detection is on, and there is no configured default. Mirror the customer: reply in",
    "the same language AND the same script they used. A message in Bengali letters is answered in",
    "Bengali letters; one typed in Latin letters is answered in Latin letters.",
    "",
    "Work down this list and stop at the first line that matches:",
    "1. Written in Bengali script? Answer in Bengali, in Bengali script.",
    "2. Written in another non-Latin script — Devanagari, Arabic, Chinese, Tamil and so on? That",
    "   script's language. Answer in it.",
    // Everything from here down is Latin letters. Greeting before English, for the reason above.
    `3. A greeting or a single word — \"hello\", \"hi\", \"ok\", \"thanks\", \"yes\", \"please\", \"sure\" —`,
    `   or only a number, a link, an invoice reference, a product name or an emoji?`,
    `   ${AUTO_TIEBREAK_LANGUAGE}. These carry no language signal at all, and a one-word greeting is`,
    "   NOT a fluent English sentence whatever language the word comes from. Use the form both a",
    "   Bengali and an English reader can follow; their next message will settle it properly.",
    "4. Bengali words written in Latin letters — \"bill kivabe generate korbo\", \"amar net kaj korche",
    "   na\"? Answer the same way: Bengali words in Latin letters. Do NOT switch to Bengali script,",
    "   and do NOT answer in English. Writing back the way they typed is the point of this mode.",
    "5. A complete, fluent sentence or question in English, of several words? English.",
    `6. Anything else — mixed languages, or a message you cannot place confidently?`,
    `   ${AUTO_TIEBREAK_LANGUAGE}.`,
  ];
}

export function buildFallbackPrompt(input: FallbackPromptInput): FallbackPrompt {
  const knowledge = input.knowledge ?? [];
  const language = input.defaultReplyLanguage?.trim() || FALLBACK_REPLY_LANGUAGE;
  const styleGuidance = input.styleGuidance?.trim() || null;

  const systemPrompt = [
    "You are assisting a WhatsApp-based customer support automation system. A customer sent a",
    "message that did not match any configured automation rule. Classify the message and, only if",
    "you are confident a short reply is safe and complete, draft one.",
    "You only ever classify and draft text — you cannot and must not attempt to send messages,",
    "execute commands, or take any action beyond returning the requested assessment.",
    "",
    ...buildLanguageRules(language),
    "You must also decide the SCOPE of the question.",
    "BUSINESS_SPECIFIC means answering it correctly requires knowing something about THIS",
    "particular company — how their software behaves, their pricing, policies, support hours,",
    "timelines, or anything about a specific customer's account, invoice or data.",
    "GENERAL means it is ordinary conversation, or a question about widely-known technology or",
    "concepts that any informed person could answer the same way for any company.",
    "When in any doubt at all, answer BUSINESS_SPECIFIC. Being wrong in that direction costs a",
    "short wait for a human; being wrong in the other direction means inventing this company's",
    "policy in front of their customer.",
    // Placed after the language and scope rules, and stated as subordinate to them, because style
    // is the least important of the three: a reply in the wrong language or one that invents
    // company policy is broken no matter how well it matches the team's voice.
    ...(styleGuidance
      ? [
          "",
          "HOUSE STYLE. This team writes to its customers like this:",
          styleGuidance,
          "Match that manner. It never overrides anything above: not the language rules, not the",
          "scope rules, and never a fact. If the style suggests being reassuring and you have",
          "nothing to reassure them with, hand over to a human instead of inventing comfort.",
        ]
      : []),
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
    "Respond in EXACTLY this format, six lines, nothing else:",
    "INTENT: <a short 2-4 word label>",
    "SCOPE: <BUSINESS_SPECIFIC or GENERAL>",
    "LANGUAGE: <the language you decided, and are writing RESPONSE in>",
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
