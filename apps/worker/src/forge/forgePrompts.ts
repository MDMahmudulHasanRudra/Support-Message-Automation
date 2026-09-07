/**
 * Prompts for turning ISPDIGITAL repository material into customer-facing support knowledge.
 *
 * Every prompt here shares one instruction block — `DISCLOSURE_RULES` — because the rule is the
 * same regardless of what is being read: the output is for an ISP administrator using the
 * product, not for a developer maintaining it. The model is asked to describe *what the software
 * does and how to use it*, never *how it is built*.
 *
 * The prompt is the first of two layers. packages/forge-client's `checkKnowledgeSafety()` is the
 * second, and it does not trust this one — see its own doc comment for why a request is not a
 * guarantee.
 *
 * Output format is the same record-separated text the existing knowledge builders use
 * (`parseKnowledgeRecords` in ../knowledge/groupKnowledgePrompt.ts), reused rather than
 * reinvented so all four knowledge sources land in one shape.
 */

import { ALLOWED_KNOWLEDGE_CATEGORIES } from "../knowledge/groupKnowledgePrompt.js";

export interface ForgePrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

/**
 * The hard line, stated as concretely as possible. Vague instructions ("do not reveal internals")
 * get interpreted generously; a list of named things does not.
 */
const DISCLOSURE_RULES = [
  "You are writing for an ISP administrator who USES this software. You are never writing for a",
  "developer who maintains it. Describe what the product does and how someone operates it.",
  "",
  "You must NEVER include any of the following, in any form, even if the material you are given",
  "contains it and even if it would make the answer more complete:",
  "- Source code, code snippets, code blocks, class names, method names, or file or folder names.",
  "- Database tables, columns, keys, relationships, schema design, or SQL of any kind.",
  "- Internal API endpoints, routes, queue names, job names, or infrastructure components",
  "  (for example: background job frameworks, message brokers, caches, web servers).",
  "- Server names, IP addresses, ports, connection strings, credentials, keys or tokens.",
  "- Error types, exception names or stack traces.",
  "",
  "When the material explains a behaviour in technical terms, restate it as the user experiences",
  "it. If a nightly background job recalculates balances, write \"balances update automatically",
  "overnight\". If a record is written to a particular table, write \"the payment is recorded",
  "against the customer's account\".",
  "",
  "If a question can only be answered by revealing one of the forbidden things, do not write a",
  "record for it at all. Producing fewer, safer entries is the correct outcome; there is no",
  "pressure to fill a quota.",
].join("\n");

/**
 * The second hard line, and it exists because the first live tier-1 run produced sixteen of these
 * and auto-verified every one:
 *
 *   "If you can't see the network map, it may be due to insufficient permissions or a temporary
 *    issue with the system. Check your permissions and try refreshing the page. If the problem
 *    persists, contact support for assistance."
 *
 * All sixteen answered a question of the form "what should I do if I can't see / can't add / get
 * an error with X", and none of the source documents described that failure at all. The model was
 * asked for "the question a customer would actually ask" and obligingly invented a troubleshooting
 * entry per feature, filling the answer from general experience because the document had nothing
 * to fill it from.
 *
 * The damage is not that the entry is useless. It is that it is *findable*: retrieval matches it
 * on ordinary words, and the AI fallback only researches the product's source, or hands the
 * conversation to a person, when retrieval comes back empty. One invented entry therefore
 * outranks both and answers a real customer with advice that fits any product ever made.
 *
 * Tier 2 already had the equivalent instinct — a module whose sources do not resolve produces
 * nothing rather than a plausible guide. This states the same restraint for the failure modes
 * inside a document that does resolve.
 */
const GROUNDING_RULES = [
  "Write a record only where the material you were given actually answers it. There is no quota.",
  "A document covering one thing should produce one record, and producing fewer, better-grounded",
  "records is always the right outcome.",
  "",
  "In particular: do NOT write a record about what to do when something goes wrong unless the",
  "material itself describes that failure and what to do about it. An answer assembled from",
  "general experience — check your permissions, make sure the required fields are filled, refresh",
  "the page, try again later, contact support — is true of every product ever made and therefore",
  "tells this customer nothing about this one.",
  "",
  "Such an answer is worse than no answer. It will be found and quoted to a customer instead of",
  "their question reaching someone who could actually help them. If the material does not say what",
  "goes wrong or how to fix it, leave that question out entirely.",
].join("\n");

const RECORD_FORMAT = [
  "Write zero or more records. Separate records with a line containing exactly ---.",
  "Each record uses exactly these fields, each on its own line:",
  "TITLE: <a short descriptive title>",
  // Read from the shared list rather than retyped: a category this parser does not recognise is
  // silently dropped by parseKnowledgeRecords, so the two must never drift.
  `CATEGORY: <one of: ${ALLOWED_KNOWLEDGE_CATEGORIES.join(", ")}>`,
  "MODULE: <the product area, or NONE>",
  "QUESTION: <the question a customer would actually ask, in their words>",
  "ANSWER: <the answer, in plain language, as you would say it to a customer>",
  "CONFIDENCE: <an integer 0-100 for how sure you are this is correct>",
  "",
  "Write nothing outside the records — no preamble, no commentary, no closing summary.",
].join("\n");

/**
 * Tier 1: a document the team already wrote for customers.
 *
 * The instruction is to PRESERVE, not to interpret — the same distinction the existing document
 * importer draws. These documents are authoritative; the job is to cut them into retrievable
 * question-and-answer form without changing what they claim. The disclosure rules still apply,
 * because a customer-facing manual in this repository was observed comparing two internal record
 * types by name.
 */
export function buildUserGuidePrompt(input: {
  documentTitle: string;
  moduleHint: string | null;
  chunk: string;
  chunkIndex: number;
  chunkCount: number;
}): ForgePrompt {
  const systemPrompt = [
    "You are turning a software product's official user documentation into support knowledge for",
    "the team that answers customer questions about it over WhatsApp.",
    "",
    "Preserve what the document says. Do not generalise it, do not improve on it, and do not add",
    "facts it does not contain. If the document gives an exact step order, keep that order. This",
    "documentation is the authority on how this product behaves.",
    "",
    GROUNDING_RULES,
    "",
    DISCLOSURE_RULES,
  ].join("\n");

  const location =
    input.chunkCount > 1 ? `\nThis is section ${input.chunkIndex + 1} of ${input.chunkCount} of the document.` : "";

  const userPrompt = [
    `Document: ${input.documentTitle}`,
    input.moduleHint ? `MODULE: ${input.moduleHint}` : null,
    location,
    "",
    "--- documentation begins ---",
    input.chunk,
    "--- documentation ends ---",
    "",
    RECORD_FORMAT,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { systemPrompt, userPrompt, maxTokens: 4000, temperature: 0 };
}

/**
 * Tier 2: no one has written a guide for this module, so read the code behind it and write one.
 *
 * The framing is deliberate. The model is told it is reading source code *in order to learn the
 * product's behaviour*, and that the code itself is a means, not the subject. Asking it to
 * "summarise this code" reliably produces developer documentation; asking "what can a user do
 * here, and what happens when they do" produces a user guide.
 */
export function buildModuleGuidePrompt(input: {
  moduleName: string;
  moduleSummary: string | null;
  /** `{ path, content }` pairs. Paths are given for the model's orientation only — never output. */
  sources: Array<{ path: string; content: string }>;
}): ForgePrompt {
  const systemPrompt = [
    "You are a product specialist writing a user guide for one area of an ISP management product.",
    "",
    "You are being shown the source code that implements this area because no user guide exists",
    "for it yet. Read it to work out what the software actually does: what screens and actions",
    "exist, what a user can do, what happens as a result, what rules and limits apply, and what",
    "commonly goes wrong. The code is how you learn the behaviour. The code is never the subject.",
    "",
    "Write the guide a support agent would want beside them: the questions customers really ask",
    "about this area, answered plainly.",
    "",
    GROUNDING_RULES,
    "",
    DISCLOSURE_RULES,
  ].join("\n");

  const sourceBlocks = input.sources.map(
    (source, index) => `--- source ${index + 1} of ${input.sources.length} ---\n${source.content}`,
  );

  const userPrompt = [
    `Product area: ${input.moduleName}`,
    input.moduleSummary ? `What it covers: ${input.moduleSummary}` : null,
    `MODULE: ${input.moduleName}`,
    "",
    ...sourceBlocks,
    "",
    RECORD_FORMAT,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { systemPrompt, userPrompt, maxTokens: 4000, temperature: 0 };
}

/**
 * Tier 3: one specific customer question that verified knowledge could not answer.
 *
 * Narrower than tier 2 on purpose — it is answering a question, not surveying an area — and it is
 * explicitly permitted to conclude that the answer is not there. A research pass that invents a
 * plausible answer is worse than one that reports a gap, because the gap is visible and the
 * invention is not.
 */
export function buildResearchPrompt(input: {
  question: string;
  moduleName: string | null;
  sources: Array<{ path: string; content: string }>;
}): ForgePrompt {
  const systemPrompt = [
    "A customer asked a question that this company's support knowledge base could not answer.",
    "You are being shown the source code of the area most likely to contain the answer.",
    "",
    "Work out, from the code, what the product actually does about the thing being asked, then",
    "write the answer as a support agent would say it to that customer.",
    "",
    "If the code does not answer the question, say so by writing no records at all. Do not guess,",
    "do not generalise from how software usually works, and do not answer a nearby question",
    "instead. An honest gap is useful; a confident wrong answer reaches a real customer.",
    "",
    DISCLOSURE_RULES,
  ].join("\n");

  const sourceBlocks = input.sources.map(
    (source, index) => `--- source ${index + 1} of ${input.sources.length} ---\n${source.content}`,
  );

  const userPrompt = [
    `The customer asked: "${input.question}"`,
    input.moduleName ? `Most likely product area: ${input.moduleName}` : null,
    input.moduleName ? `MODULE: ${input.moduleName}` : null,
    "",
    ...sourceBlocks,
    "",
    "Write at most two records: the direct answer, and at most one closely-related question a",
    "customer asking this would ask next. Write none if the answer is not here.",
    "",
    RECORD_FORMAT,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { systemPrompt, userPrompt, maxTokens: 2000, temperature: 0 };
}

/**
 * Picks the Forge module most likely to answer a question, by keyword overlap against each
 * module's name and summary.
 *
 * Deliberately not an AI call: it runs before the research pass and choosing wrongly only costs
 * one wasted read, while an extra completion per unanswered question costs money on every miss.
 * Exported for unit testing without a network.
 */
export function selectModuleForQuestion<T extends { name: string; slug: string; summary: string | null }>(
  question: string,
  modules: T[],
): T | null {
  const words = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  if (words.size === 0 || modules.length === 0) return null;

  let best: { module: T; score: number } | null = null;
  for (const module of modules) {
    const haystack = `${module.name} ${module.slug} ${module.summary ?? ""}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) best = { module, score };
  }
  return best?.module ?? null;
}
