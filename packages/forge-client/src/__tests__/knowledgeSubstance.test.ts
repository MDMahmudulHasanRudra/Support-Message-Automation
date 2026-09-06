import { describe, expect, it } from "vitest";
import { checkKnowledgeSubstance, describeSubstanceReason } from "../knowledgeSubstance.js";

/**
 * Every string in the "real entries" blocks below was taken verbatim from the live knowledge base.
 * The gate is only worth having if it separates those two sets, so they are the test — the same
 * reasoning `knowledgeSafety.test.ts` applies to the strings that actually leaked.
 */

describe("checkKnowledgeSubstance — real entries that must PASS", () => {
  it("keeps an answer that names a screen and a selection", () => {
    const verdict = checkKnowledgeSubstance(
      'You can view the bandwidth bills by navigating to the "Bandwidth Bill" section in the software. ' +
        "From there, select the reseller and the billing period to see the corresponding bills.",
    );
    expect(verdict.substantive).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("keeps a statement of product behaviour carrying a real quantity", () => {
    // Names no button at all, and is one of the best entries in the base. Brevity and
    // menu-free phrasing are not the defect this gate is looking for.
    const verdict = checkKnowledgeSubstance(
      "Billing periods are created automatically when accessed for the first time. There are 12 monthly " +
        "periods in a year, and each period must be activated by an administrator before it becomes " +
        "visible in the system.",
    );
    expect(verdict.substantive).toBe(true);
  });

  it("keeps an answer that names real integrations", () => {
    const verdict = checkKnowledgeSubstance(
      "The software integrates with various systems including Mikrotik RouterOS for customer provisioning, " +
        "bKash and Nagad for mobile payments, and several others for online payment processing.",
    );
    expect(verdict.substantive).toBe(true);
  });

  it("allows a good answer to close by pointing at a person", () => {
    // One marker is ordinary. Flagging it would punish answers for being helpful about their
    // own limits, which is the opposite of what this is for.
    const verdict = checkKnowledgeSubstance(
      "To use the Period Summary report, choose a year from the Year dropdown. The report will show key " +
        "metrics for each month and year-to-date totals. If the problem persists, contact support.",
    );
    expect(verdict.substantive).toBe(true);
  });
});

describe("checkKnowledgeSubstance — real entries that must FAIL", () => {
  it("flags an answer built out of universal troubleshooting advice", () => {
    const verdict = checkKnowledgeSubstance(
      "If the dashboard is not loading, try refreshing the page. If the issue persists, check your internet " +
        "connection or clear your browser cache. If none of these steps work, contact your IT support for " +
        "further assistance.",
    );
    expect(verdict.substantive).toBe(false);
    expect(verdict.reasons).toContain("generic-advice");
  });

  it("flags the 'check the required fields' non-answer", () => {
    const verdict = checkKnowledgeSubstance(
      "If you encounter an error when saving a product, it may be due to missing or incorrect information. " +
        "Check that all required fields are filled out correctly and try saving again. If the problem " +
        "persists, please contact support.",
    );
    expect(verdict.substantive).toBe(false);
    expect(verdict.reasons).toContain("generic-advice");
  });


});

describe("naming nothing concrete is advisory, not disqualifying", () => {
  // Learned from running this over the live base: 88 of 318 verified entries name no screen and
  // no number, and reading them showed most were real descriptions of how the product behaves.
  // Failing them would have sent good answers back for review and hidden the genuine filler.
  const REAL_BEHAVIOUR_NO_ANCHOR =
    "Yes, a bill can be canceled, which creates a reversal entry. This means the cancellation is " +
    "recorded without deleting the original bill, and it remains visible in the customer's history.";

  it("keeps a descriptive answer that names no screen and no quantity", () => {
    const verdict = checkKnowledgeSubstance(REAL_BEHAVIOUR_NO_ANCHOR);
    expect(verdict.substantive).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("still reports it as bare, so a review queue can be sorted by it", () => {
    expect(checkKnowledgeSubstance(REAL_BEHAVIOUR_NO_ANCHOR).bare).toBe(true);
  });

  it("does not mark a menu-naming answer as bare", () => {
    const verdict = checkKnowledgeSubstance(
      'Open the "Bandwidth Bill" section, then select the reseller and the billing period to see the bills.',
    );
    expect(verdict.bare).toBe(false);
  });
});

describe("short but dense answers survive — the entries a length rule wrongly withheld", () => {
  // Verbatim from the first live sync after the gate shipped. A 120-character floor held all
  // three back, and all three were among the best entries in that batch of 132.
  const WITHHELD_IN_PRODUCTION = [
    "The procurement workflow is: Requisition (Request) --> Approval --> Purchase Order --> Goods Receipt --> Payment.",
    "The due amount for each period includes all unpaid balances from all previous periods.",
    "Every financial transaction creates balanced journal entries to ensure double-entry accounting.",
  ];

  for (const answer of WITHHELD_IN_PRODUCTION) {
    it(`keeps: ${answer.slice(0, 45)}…`, () => {
      const verdict = checkKnowledgeSubstance(answer);
      expect(verdict.substantive).toBe(true);
      expect(verdict.reasons).toEqual([]);
    });
  }
});

describe("reasons are reportable", () => {
  it("describes every rule it can emit", () => {
    for (const id of ["generic-advice"]) {
      expect(describeSubstanceReason(id)).not.toMatch(/did not meet/);
    }
  });

  it("flags a short answer that is nothing but boilerplate", () => {
    const verdict = checkKnowledgeSubstance("Try again later or contact support for further assistance.");
    expect(verdict.substantive).toBe(false);
    expect(verdict.reasons).toEqual(["generic-advice"]);
  });
});
