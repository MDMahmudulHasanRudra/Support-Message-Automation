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
import { formatConversationTranscript, type ConversationTurn } from "./conversationContext.js";

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
  /**
   * The turns before this message in the same conversation, oldest first, already reduced to
   * roles (`conversationContext.ts`). Present so a follow-up reads as a follow-up — "same process
   * for this client?" is unanswerable without it, and was being answered anyway.
   *
   * It is context, never evidence. What was said earlier explains the question; only verified
   * knowledge may justify the answer, and the prompt says so in as many words.
   */
  conversation?: ConversationTurn[];
  /**
   * Structural instructions derived from the retrieved evidence by `answerPlan.ts` — how many
   * documented procedures were found, and whether a how-to question has none at all.
   *
   * Already-rendered text rather than the plan object, so this module keeps its single job of
   * assembling a prompt and stays testable without importing the planner. Empty string in the
   * ordinary case (one workflow, or a factual question), in which case the prompt is byte-identical
   * to what it was before the planner existed.
   */
  planGuidance?: string;
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
  const transcript = formatConversationTranscript(input.conversation ?? []);
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
    "",
    "HOW TO WRITE THE ANSWER. Somebody is trying to get something done, so answer the way a",
    "colleague at the next desk would explain it, not the way documentation would.",
    "If the question is about doing something in the product, give the steps in the order they are",
    "actually done, naming what the person opens or clicks at each one — \"Billing list → Payment →",
    "Pay → enter the due amount → choose the receiving account → Submit\" is worth more than a",
    "paragraph describing the same thing. Number them when there is more than one.",
    "Keep it warm and plain. No jargon the customer did not use first, no restating their question",
    "back at them, no closing paragraph that adds nothing.",
    "NEVER INVENT A STEP. This is the one rule here that outranks being helpful: a screen that does",
    "not exist or a button in the wrong place sends somebody hunting through software they already",
    "find confusing, and it is worse than telling them a person will help. If the reference material",
    "covers part of the task, give that part and hand over for the rest — say plainly where your",
    "instructions stop rather than smoothing over the join.",
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
    ...(transcript
      ? [
          "CONVERSATION SO FAR. You are given the recent turns of this conversation because a",
          "customer's message is often a follow-up — \"does the same apply here?\" means nothing on",
          "its own, and answering it as though it were a fresh question is how a confident wrong",
          "answer gets sent. Use the transcript to work out WHAT IS BEING ASKED.",
          "Never use it to work out what is TRUE. Earlier replies in it are what was said, not what",
          "has been verified — including this system's own, which may have been wrong. A fact still",
          "has to come from the reference material or from a person, exactly as it would if the",
          "conversation were not there.",
          "The language rules above read the LATEST customer message only. Decide the language from",
          "that message, never from the transcript — detection is per message and does not latch,",
          "so a conversation held in one language does not decide the language of the next reply.",
        ]
      : []),
    ...(input.planGuidance?.trim()
      ? [
          "",
          "HOW THIS ANSWER MUST BE STRUCTURED. Derived from the reference material below, not from",
          "a guess about it — treat it as describing what the material actually contains.",
          input.planGuidance.trim(),
          "",
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
  ]
    // Joined on NEWLINES, not spaces.
    //
    // Every block above is authored as discrete lines — most of all `buildLanguageRules`, which
    // returns a numbered checklist and instructs the model to "work down this list and stop at
    // the first line that matches". Joined with a space there were no lines: the seven rules, the
    // scope rules and the style notes all ran together into one paragraph, and the blank-string
    // separators meant to break sections became double spaces in the middle of a sentence. The
    // ordering those blocks are so careful about was still there and much harder to follow.
    //
    // The words are unchanged; only the separator is.
    .join("\n");

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
              // Last because it is the most concrete thing in the entry: when a procedure is
              // present it is what the reply should be built from, and the model reads the end of
              // a block more reliably than the middle.
              entry.procedure ? `   Steps: ${entry.procedure}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        ]
      : [];

  const conversationBlock = transcript
    ? ["", "Conversation so far (oldest first, this team's replies marked SUPPORT):", transcript, ""]
    : [];

  const userPrompt = [
    `Group: ${input.groupName ?? "(direct message)"}`,
    ...conversationBlock,
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

  // 400 was the budget when this prompt asked for a short acknowledgement. It now asks for a
  // procedure — "the steps in the order they are actually done, naming what the person opens or
  // clicks" — and it has to fit five metadata lines in front of the reply, in a deployment whose
  // default reply language is Bengali, which costs several tokens per character in every
  // tokenizer this talks to. A numbered Bengali procedure did not fit, and since `truncated` is
  // now honoured the overflow became a TRUNCATED_RESPONSE handover rather than a half-sent
  // answer: safe, but it meant the better the knowledge base got at procedures, the more often
  // the AI handed over instead of answering.
  //
  // Still a ceiling, not a target — the prompt's own "no closing paragraph that adds nothing" is
  // what keeps replies short, and a runaway answer is still cut off and still handed over.
  return { systemPrompt, userPrompt, maxTokens: 900, temperature: 0 };
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

  // A percentage, or nothing. Clamping was the wrong instinct: `Math.min(100, 900)` turned a
  // garbled line into MAXIMUM confidence, which then cleared the threshold and sent the reply.
  // A number the model could not have meant is evidence that the response format broke, and a
  // broken format is precisely what MALFORMED_RESPONSE exists to catch — null is how
  // runAiFallback reads that.
  const confidence = readConfidence(confidenceMatch?.[1]);

  const shouldReply = shouldReplyMatch ? shouldReplyMatch[1]!.toUpperCase() === "YES" : false;

  let responseText: string | null = null;
  if (responseMatch) {
    const raw = stopAtNextMetadataLine(responseMatch[1]!).trim();
    responseText = raw.length === 0 || raw.toUpperCase() === "NONE" ? null : raw;
  }

  return { intent, scope, confidence, shouldReply, responseText };
}

function readConfidence(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return value;
}

/**
 * The metadata lines, as they appear at the START of a line and nowhere else.
 *
 * Anchored to a line beginning on purpose. An ordinary reply is full of colons — "Billing list →
 * Payment → Pay: enter the amount" — and cutting at the first one anywhere would truncate real
 * answers mid-procedure, which is a worse failure than the leak this prevents.
 */
const METADATA_LINE = /^\s*(?:INTENT|SCOPE|LANGUAGE|CONFIDENCE|SHOULD_REPLY)\s*:/im;

/**
 * Trims anything after `RESPONSE:` that is plainly the model's own metadata rather than the reply.
 *
 * `RESPONSE:` was extracted with `[\s\S]+` — everything to the end of the string — on the
 * assumption that it is the last line of the required format. At temperature 0 with an explicit
 * six-line template it nearly always is. The one time it is not, the leftover
 * "CONFIDENCE: 95 / SHOULD_REPLY: YES" is queued and sent to the customer verbatim: nothing
 * downstream inspects the reply text, and every gate above it has already passed.
 *
 * Deliberately a trim rather than a rejection. The reply itself is there and is fine; discarding
 * it over the model's line ordering would cost a customer their answer to fix a formatting slip.
 */
function stopAtNextMetadataLine(afterResponseMarker: string): string {
  const match = afterResponseMarker.match(METADATA_LINE);
  return match?.index === undefined ? afterResponseMarker : afterResponseMarker.slice(0, match.index);
}
