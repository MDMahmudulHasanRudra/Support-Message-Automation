import { containsWholeWord, normalizeText } from "@support-automation/engine";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

/**
 * Turns retrieved evidence into a small, factual plan for the answer — what kind of question this
 * is, which documented workflows exist for it, and what the evidence does NOT establish.
 *
 * DETERMINISTIC ON PURPOSE. Nothing here asks a model anything. The plan is derived entirely from
 * rows that were already retrieved, so every conclusion in it is grounded by construction rather
 * than by a second model being trusted to reason honestly. That is also why there is no second AI
 * call: an extra round trip in front of a waiting customer, to produce reasoning we would then
 * have to validate, buys nothing that reading the evidence does not already give.
 *
 * It carries conclusions, never private reasoning, and it is never shown to the customer.
 *
 * The division of labour is the point: CODE decides the structure — is this a how-to, how many
 * distinct procedures were found, is a procedure missing — and the MODEL handles language and
 * explanation. Conditions and prerequisites stay in the evidence text where the model can read
 * them; parsing prose for branch logic in code would be brittle and would invent structure the
 * source never stated.
 */

/** What the customer is asking for, as far as the wording supports. */
export type QuestionShape = "PROCEDURAL" | "FACTUAL";

export interface PlannedWorkflow {
  /** The knowledge entry this came from, so a reviewer can trace the answer to its source. */
  id: string;
  title: string;
  module: string | null;
  /** The documented steps, verbatim. Never generated here. */
  steps: string;
}

export interface AnswerPlan {
  shape: QuestionShape;
  /** Evidence entries that carry documented steps — one per distinct documented workflow. */
  workflows: PlannedWorkflow[];
  /** Titles of the entries that explain or qualify but carry no steps. */
  supportingTitles: string[];
  /** Product areas the evidence covers, deduplicated. */
  modules: string[];
  /** More than one documented procedure is relevant — they must be offered, never merged. */
  hasMultipleWorkflows: boolean;
  /**
   * The customer asked how to do something and NOT ONE retrieved entry contains steps. The answer
   * must say so rather than assembling a plausible sequence.
   */
  missingProcedure: boolean;
  evidenceCount: number;
}

/**
 * Words that mark a request for a method rather than a fact, across the three ways this
 * deployment's customers actually write.
 *
 * Matched whole-word via the engine's own helper so "korbo" does not fire inside another token,
 * and normalised through the same `normalizeText` retrieval uses, so Bengali combining marks are
 * handled identically here and there.
 */
const PROCEDURAL_TOKENS = [
  // Bengali
  "কিভাবে",
  "কীভাবে",
  "কেমনে",
  "করব",
  "করবো",
  "করতে",
  "নিয়ম",
  "পদ্ধতি",
  // Banglish
  "kivabe",
  "kibhabe",
  "kemne",
  "kemney",
  "korbo",
  "korte",
  "koris",
  "niyom",
  // English
  "how",
  "steps",
  "step",
  "procedure",
  "process",
  "setup",
  "configure",
];

/** Multi-word English forms a single-token test would miss. */
const PROCEDURAL_PHRASES = ["how do i", "how to", "how can i", "how does one", "what are the steps"];

export function detectQuestionShape(customerMessage: string): QuestionShape {
  const normalized = normalizeText(customerMessage);
  if (PROCEDURAL_PHRASES.some((phrase) => normalized.includes(phrase))) return "PROCEDURAL";
  if (PROCEDURAL_TOKENS.some((token) => containsWholeWord(normalized, token))) return "PROCEDURAL";
  return "FACTUAL";
}

export function buildAnswerPlan(customerMessage: string, knowledge: KnowledgeSnippet[]): AnswerPlan {
  const shape = detectQuestionShape(customerMessage);

  const workflows: PlannedWorkflow[] = knowledge
    .filter((entry) => Boolean(entry.procedure?.trim()))
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      module: entry.module ?? null,
      steps: entry.procedure!.trim(),
    }));

  const supportingTitles = knowledge
    .filter((entry) => !entry.procedure?.trim())
    .map((entry) => entry.title);

  const modules = [...new Set(knowledge.map((entry) => entry.module).filter((m): m is string => Boolean(m)))];

  return {
    shape,
    workflows,
    supportingTitles,
    modules,
    hasMultipleWorkflows: workflows.length > 1,
    missingProcedure: shape === "PROCEDURAL" && workflows.length === 0,
    evidenceCount: knowledge.length,
  };
}

/**
 * Renders the plan as the instruction block the prompt carries.
 *
 * Returns an empty string when there is nothing structural to say — a single documented workflow,
 * or a plain factual question — so the ordinary prompt is unchanged in the common case and this
 * only speaks up where it has something specific to enforce.
 */
export function renderAnswerPlan(plan: AnswerPlan): string {
  const lines: string[] = [];

  if (plan.hasMultipleWorkflows) {
    lines.push(
      "MORE THAN ONE DOCUMENTED WAY TO DO THIS.",
      `The reference material contains ${plan.workflows.length} separate documented procedures for this:`,
      ...plan.workflows.map((workflow, index) => `  ${index + 1}. ${workflow.title}`),
      "Present them as separate, clearly labelled options, each with its own steps. NEVER interleave",
      "them into a single sequence: they are different routes, and a merged list is a procedure that",
      "exists in no documentation and will not work. If the customer's message already names one of",
      "them, lead with that one and mention the other only briefly.",
    );
  }

  if (plan.missingProcedure) {
    lines.push(
      "NO DOCUMENTED STEPS FOR THIS.",
      "The customer is asking how to do something, and NOT ONE piece of reference material contains",
      "the steps. Explain what the material does support, then say plainly that the exact steps are",
      "not documented and a colleague will confirm them. Do NOT assemble a likely-looking sequence",
      "from the product area, the feature name, or how software of this kind usually works — a",
      "screen that does not exist sends somebody hunting through software they already find",
      "confusing, and is worse than telling them a person will help.",
    );
  }

  return lines.join("\n");
}

/** Ordered-list markers in the scripts this deployment answers in — "1." / "1)" and Bengali "১." */
const ORDERED_STEP_MARKER = /(^|\n)\s*(?:[0-9]+|[০-৯]+)\s*[.)]\s+\S/g;

export interface GroundingVerdict {
  ok: boolean;
  /** Set when the check failed — recorded as the handover reason. */
  reason?: string;
}

/**
 * The last gate before a drafted reply is queued: did the model produce a procedure that no
 * evidence supports?
 *
 * Deliberately narrow, and narrow in a direction that matters. It fires only when all three are
 * true — the customer asked how to do something, NOT ONE retrieved entry carried steps, and the
 * draft nonetheless contains an ordered list. That combination is the invented procedure the
 * prompt's NEVER INVENT A STEP rule exists to prevent, caught mechanically rather than trusted to
 * the model, because a request is not a guarantee.
 *
 * It is not a general hallucination detector and does not pretend to be. A numbered list in a
 * factual answer, or one alongside real documented steps, is left alone — blocking those would
 * cost real answers to buy nothing, and a gate that blocks good answers gets switched off.
 */
export function validateGrounding(replyText: string, plan: AnswerPlan): GroundingVerdict {
  if (!plan.missingProcedure) return { ok: true };

  const matches = replyText.match(ORDERED_STEP_MARKER);
  if ((matches?.length ?? 0) >= 2) {
    return {
      ok: false,
      reason: "INVENTED_PROCEDURE",
    };
  }

  return { ok: true };
}
