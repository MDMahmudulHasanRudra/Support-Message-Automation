import { prisma } from "@support-automation/db";
import { evidenceFingerprint } from "@support-automation/shared";
import type { AnswerPlan } from "./answerPlan.js";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

/**
 * The runtime EvidenceBundle, and the record of it.
 *
 * These are deliberately two different things. The BUNDLE is assembled per request, handed to the
 * model, and thrown away; the SNAPSHOT is what was in it, kept so the reply can still be explained
 * after the knowledge behind it has been edited. Keeping them separate is what stops the
 * persistence shape dictating the processing shape, or vice versa — the bundle can grow a field
 * without a migration, and the snapshot can be read without reconstructing a request.
 *
 * What a snapshot answers, six months later: *which version of which entry did the AI actually
 * read when it said that?* Without it, `AiFallbackDecision.responseText` records what was said and
 * nothing about why, so editing a knowledge entry silently makes every past answer built on it
 * unexplainable. That is the failure this module exists to prevent, and it is not recoverable
 * after the fact — the evidence has to be recorded at the moment it is used or not at all.
 *
 * **References, not copies.** The question is reachable through the decision's own message; the
 * evidence text through `AiKnowledgeVersion`, keyed by the version number recorded here. Only a
 * title is denormalised, so a snapshot whose knowledge item was later deleted is still readable
 * rather than a row of null ids.
 *
 * **No reasoning is stored.** Not the prompt, not the model's working, nothing resembling
 * chain-of-thought — only the operational structure: what was retrieved, in what order, and what
 * the deterministic planner concluded from it.
 */

/**
 * The assembled evidence for one question, as the pipeline holds it in memory.
 *
 * A type rather than a table on purpose. Making this a first-class runtime concept costs nothing
 * and gives the stages between retrieval and generation something precise to pass around;
 * persisting it as its own entity would add a write to the hot path for data that is fully
 * derivable from the snapshot below.
 */
export interface EvidenceBundle {
  question: string;
  intent: string | null;
  knowledge: KnowledgeSnippet[];
  plan: AnswerPlan;
  /**
   * Conflicts between sources that disagree. Always empty today: conflict detection is a
   * deliberately unbuilt stage, and an empty array is the honest representation of "not checked"
   * — the field exists so the stage has somewhere to put its output, not to imply it ran.
   */
  conflicts: never[];
}

export function buildEvidenceBundle(params: {
  question: string;
  intent: string | null;
  knowledge: KnowledgeSnippet[];
  plan: AnswerPlan;
}): EvidenceBundle {
  return { ...params, conflicts: [] };
}

/**
 * The fingerprint of a bundle — identical exactly when the evidence was identical.
 *
 * This is what makes model comparison meaningful. Ask the same question of two models and the
 * outputs differ for one of two reasons: the models, or the evidence they were given. Only the
 * first is interesting, and only this can rule out the second.
 */
export function fingerprintOf(bundle: EvidenceBundle): string {
  return evidenceFingerprint({
    items: bundle.knowledge.map((entry) => ({ id: entry.id, version: entry.version })),
    questionShape: bundle.plan.shape,
    missingProcedure: bundle.plan.missingProcedure,
    workflowCount: bundle.plan.workflows.length,
  });
}

/**
 * Records the bundle against a decision that has already been written.
 *
 * **Never throws.** A snapshot is an audit record of something that has already happened: the
 * decision row exists, and by the time this runs the customer has been answered or handed over.
 * Failing the interaction because its documentation could not be filed would trade a real outcome
 * for a record of it. The failure is logged loudly instead, because a missing snapshot is a real
 * gap in explainability and must not pass silently.
 */
export async function recordEvidenceSnapshot(params: {
  decisionId: string;
  bundle: EvidenceBundle;
  fingerprint: string;
}): Promise<void> {
  const { bundle } = params;
  try {
    await prisma.aiEvidenceSnapshot.create({
      data: {
        decisionId: params.decisionId,
        fingerprint: params.fingerprint,
        questionShape: bundle.plan.shape,
        intent: bundle.intent,
        knowledgeCount: bundle.knowledge.length,
        workflowCount: bundle.plan.workflows.length,
        missingProcedure: bundle.plan.missingProcedure,
        conflictCount: bundle.conflicts.length,
        items: {
          create: bundle.knowledge.map((entry, index) => ({
            knowledgeItemId: entry.id,
            // The version AS RETRIEVED, carried down from the search rather than re-read. Re-reading
            // would fetch whatever the entry had become between retrieval and now, which for an
            // entry edited in that window is exactly the wrong answer.
            knowledgeVersion: entry.version,
            rank: index,
            title: entry.title,
            scope: entry.scope,
            hadProcedure: Boolean(entry.procedure?.trim()),
            fromSameGroup: entry.fromSameGroup,
          })),
        },
      },
    });
  } catch (err) {
    // P2002 means this decision already has a snapshot, which happens when a stranded message is
    // re-run — the decision write is idempotent, so this is too, and there is nothing to report.
    if ((err as { code?: string }).code === "P2002") return;
    console.error("[aiFallback] could not record the evidence snapshot for this answer", err);
  }
}
