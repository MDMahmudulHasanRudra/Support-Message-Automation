/**
 * The AI Sandbox's review rules, as pure decisions — so they are unit-tested rather than only
 * enforced inside server actions that need a signed-in request to run. `apps/web`'s sandbox
 * actions call these and refuse with the returned reason; the UI offers only what they allow.
 *
 *   ask -> AI answers -> (edit) -> Verify -> Make Knowledge
 *
 *   1. The FINAL answer is the admin's edit when there is one, else the AI's answer. Verify and
 *      Make Knowledge only ever use it; the original AI answer is never overwritten.
 *   2. Only a VERIFIED (APPROVED) answer can become knowledge, and only once.
 *   3. A REJECTED answer cannot be edited or become knowledge until it is reopened.
 *   4. Saving an edit to a verified answer returns it to WAITING — the verification was of the
 *      old words.
 *   5. Once saved as knowledge, the knowledge entry is what gets edited, not the sandbox turn.
 * Each turn is judged on its own; nothing here spans a conversation.
 */

export type SandboxReview = "WAITING" | "APPROVED" | "REJECTED";

export interface SandboxTurnState {
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
  review: SandboxReview;
  responseText: string | null;
  editedResponseText: string | null;
  promotedKnowledgeItemId: string | null;
}

export type Decision = { ok: true } | { ok: false; reason: string };
const allow: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, reason });

/** Rule 1. Null when there is nothing to verify yet (a handover nobody has written an answer for). */
export function sandboxFinalAnswer(turn: Pick<SandboxTurnState, "responseText" | "editedResponseText">): string | null {
  return turn.editedResponseText?.trim() || turn.responseText?.trim() || null;
}

export function canEditSandboxAnswer(turn: SandboxTurnState): Decision {
  if (turn.status !== "COMPLETE") return deny("Wait for the AI's answer before editing it.");
  if (turn.review === "REJECTED") return deny("This answer was rejected. Reopen it before editing.");
  if (turn.promotedKnowledgeItemId) {
    return deny("This answer is already knowledge. Edit the knowledge entry so its history stays in one place.");
  }
  return allow;
}

export function canSetSandboxReview(turn: SandboxTurnState, next: SandboxReview): Decision {
  if (turn.status !== "COMPLETE") return deny("This turn has no answer to review yet.");
  if (next === "APPROVED" && !sandboxFinalAnswer(turn)) {
    return deny("There is no answer to verify. Write one with Edit answer first.");
  }
  if (turn.promotedKnowledgeItemId && next !== "APPROVED") {
    return deny("This answer is already saved as knowledge. Edit or archive the knowledge entry instead.");
  }
  return allow;
}

export function canMakeSandboxKnowledge(turn: SandboxTurnState): Decision {
  if (turn.review === "REJECTED") return deny("A rejected answer cannot become knowledge. Reopen and verify it first.");
  if (turn.review !== "APPROVED") return deny("Verify the answer before making it knowledge.");
  if (turn.promotedKnowledgeItemId) return deny("This answer has already been saved to the knowledge base.");
  if (!sandboxFinalAnswer(turn)) return deny("This turn has no answer to save.");
  return allow;
}

/**
 * What saving an edit writes. Saving the AI's own words back unchanged clears the edit rather than
 * recording a correction that is not one. Rule 4 decides whether verification is withdrawn.
 */
export function applySandboxEdit(
  turn: Pick<SandboxTurnState, "responseText" | "review">,
  text: string,
): { editedResponseText: string | null; review: SandboxReview; verificationWithdrawn: boolean } {
  const answer = text.trim();
  const unchanged = answer === (turn.responseText ?? "").trim();
  const verificationWithdrawn = turn.review === "APPROVED";
  return {
    editedResponseText: unchanged ? null : answer,
    review: verificationWithdrawn ? "WAITING" : turn.review,
    verificationWithdrawn,
  };
}
