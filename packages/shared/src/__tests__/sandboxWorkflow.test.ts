import { describe, expect, it } from "vitest";
import {
  applySandboxEdit,
  canEditSandboxAnswer,
  canMakeSandboxKnowledge,
  canSetSandboxReview,
  sandboxFinalAnswer,
  type SandboxTurnState,
} from "../sandboxWorkflow.js";

/** The AI Sandbox review rules — the spec's Tests 1-5, at the level they are decided. */

const AI = "To pay your bill, field employees will collect the payment.";
const EDITED = "You can pay your bill through the DailyBill collection process.";

const turn = (overrides: Partial<SandboxTurnState> = {}): SandboxTurnState => ({
  status: "COMPLETE",
  review: "WAITING",
  responseText: AI,
  editedResponseText: null,
  promotedKnowledgeItemId: null,
  ...overrides,
});

describe("Test 1 — normal approval", () => {
  it("an unedited answer verifies and can become knowledge, with the AI's words", () => {
    expect(canSetSandboxReview(turn(), "APPROVED").ok).toBe(true);
    const verified = turn({ review: "APPROVED" });
    expect(canMakeSandboxKnowledge(verified).ok).toBe(true);
    expect(sandboxFinalAnswer(verified)).toBe(AI);
  });
});

describe("Test 2 — the edited answer is the one that counts", () => {
  it("the final answer is the edit, never the original", () => {
    expect(sandboxFinalAnswer(turn({ editedResponseText: EDITED }))).toBe(EDITED);
  });

  it("an edit keeps the original AI answer untouched", () => {
    const applied = applySandboxEdit(turn(), EDITED);
    expect(applied.editedResponseText).toBe(EDITED);
    // responseText is not part of what an edit writes at all.
    expect(applied).not.toHaveProperty("responseText");
  });

  it("editing a VERIFIED answer withdraws the verification", () => {
    expect(applySandboxEdit(turn({ review: "APPROVED" }), EDITED)).toMatchObject({
      review: "WAITING",
      verificationWithdrawn: true,
    });
  });

  it("saving the AI's own words back is not an edit", () => {
    expect(applySandboxEdit(turn(), `  ${AI}  `).editedResponseText).toBeNull();
  });

  it("a handover with no AI answer can be answered by the admin, then verified", () => {
    const handover = turn({ responseText: null });
    expect(canSetSandboxReview(handover, "APPROVED").ok).toBe(false);
    expect(canEditSandboxAnswer(handover).ok).toBe(true);
    expect(canSetSandboxReview(turn({ responseText: null, editedResponseText: EDITED }), "APPROVED").ok).toBe(true);
  });
});

describe("Test 3 — rejected answers cannot become knowledge", () => {
  it("cannot be made knowledge, nor edited, until reopened", () => {
    const rejected = turn({ review: "REJECTED" });
    expect(canMakeSandboxKnowledge(rejected)).toMatchObject({ ok: false });
    expect(canEditSandboxAnswer(rejected)).toMatchObject({ ok: false });
    expect(canSetSandboxReview(rejected, "WAITING").ok).toBe(true); // reopen
  });

  it("a waiting answer cannot skip verification", () => {
    expect(canMakeSandboxKnowledge(turn())).toMatchObject({ ok: false });
  });
});

describe("once saved as knowledge", () => {
  it("cannot be saved twice, edited here, or un-verified here", () => {
    const saved = turn({ review: "APPROVED", promotedKnowledgeItemId: "k1" });
    expect(canMakeSandboxKnowledge(saved).ok).toBe(false);
    expect(canEditSandboxAnswer(saved).ok).toBe(false);
    expect(canSetSandboxReview(saved, "WAITING").ok).toBe(false);
  });
});

describe("Test 5 — each answer is judged on its own", () => {
  it("two turns in one conversation keep independent states", () => {
    const first = turn({ review: "APPROVED", promotedKnowledgeItemId: "k1" });
    const second = turn();
    expect(canMakeSandboxKnowledge(first).ok).toBe(false);
    expect(canSetSandboxReview(second, "APPROVED").ok).toBe(true);
  });
});
