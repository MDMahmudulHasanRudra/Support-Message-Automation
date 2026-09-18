import { describe, expect, it } from "vitest";
import {
  buildAnswerPlan,
  detectQuestionShape,
  renderAnswerPlan,
  validateGrounding,
} from "../aiFallback/answerPlan.js";
import { buildFallbackPrompt } from "../aiFallback/prompt.js";
import type { KnowledgeSnippet } from "../aiFallback/knowledgeContext.js";

/**
 * Answer planning: the stage that decides HOW an answer must be shaped before the model writes
 * it. Pure — no database, no AI client — which is the point of building the plan deterministically
 * from evidence rather than asking a model to reason about it.
 */

function snippet(over: Partial<KnowledgeSnippet> = {}): KnowledgeSnippet {
  return {
    id: "k1",
    title: "Untitled",
    question: null,
    answer: "Some answer.",
    procedure: null,
    module: null,
    fromSameGroup: false,
    ...over,
  };
}

describe("question shape", () => {
  it("reads a how-to in English, Bengali and Banglish", () => {
    for (const q of [
      "How do I upgrade a package?",
      "what are the steps to add a client",
      "ভাই package upgrade করতে চাই, কিভাবে করবো?",
      "প্যাকেজ আপগ্রেডের নিয়ম কি",
      "package upgrade kivabe korbo",
      "bill payment kemne korte hoy",
    ]) {
      expect(detectQuestionShape(q), q).toBe("PROCEDURAL");
    }
  });

  it("does not read a plain factual question as a how-to", () => {
    for (const q of ["What are your office hours?", "আপনাদের অফিস কখন খোলা", "is the server down"]) {
      expect(detectQuestionShape(q), q).toBe("FACTUAL");
    }
  });

  it("reads the `X korar <noun>` construction as a how-to", () => {
    // The gap the final audit found, reproduced against real phrasings. The token list carried
    // `korbo`/`korte`/`koris` but not `korar` — the form used in the single most common Banglish
    // how-to construction, "X korar niyom/upay/system/way". Every one of these read as FACTUAL, so
    // `missingProcedure` stayed false, `renderAnswerPlan` emitted no "no documented steps"
    // instruction, and `validateGrounding` returned ok without testing anything.
    for (const q of [
      "package upgrade korar system ta ki",
      "invoice void korar upay ki",
      "recharge korar way ki",
      "bill generate korar poddhoti",
      "customer add korar niyom ki",
    ]) {
      expect(detectQuestionShape(q), q).toBe("PROCEDURAL");
    }
  });

  it("reads `ki vabe` written as two words", () => {
    // `kivabe` was a token; the spaced form people actually type was not, so the most literal way
    // of writing "how" in Banglish was the one that missed.
    for (const q of ["ki vabe bill dibo", "ki bhabe package change korbo", "kemne korbo eta"]) {
      expect(detectQuestionShape(q), q).toBe("PROCEDURAL");
    }
  });

  it("still does not fire on ordinary English containing `system` or `way`", () => {
    // `system` and `way` were deliberately NOT added as bare tokens. Both listed examples reach
    // PROCEDURAL through `korar` already, and as standalone English words they appear constantly
    // in ordinary support conversation — classifying those as how-to questions would demand
    // documented steps that do not exist and hand over answers the system could have given.
    for (const q of ["the system is down", "the engineer is on the way", "is there any way to check"]) {
      expect(detectQuestionShape(q), q).toBe("FACTUAL");
    }
  });
});

describe("the invented-procedure gate actually engages for those questions", () => {
  it("blocks an invented numbered procedure for a `korar <noun>` question", () => {
    // End to end, and the reason H1 mattered: it is not about a label, it is about whether the
    // last mechanical guard against an invented procedure runs at all.
    const plan = buildAnswerPlan("recharge korar way ki", [
      snippet({ id: "a", title: "Recharge", procedure: null }),
    ]);
    expect(plan.missingProcedure).toBe(true);

    const invented = ["1. Open Billing", "2. Click Recharge", "3. Enter amount", "4. Submit"].join("\n");
    expect(validateGrounding(invented, plan).ok).toBe(false);
  });
});

describe("single documented workflow", () => {
  const plan = buildAnswerPlan("how do I record a payment", [
    snippet({ id: "a", title: "Record a payment", module: "Billing", procedure: "1. Open Billing\n2. Press Pay" }),
  ]);

  it("finds the one workflow and reports no ambiguity", () => {
    expect(plan.shape).toBe("PROCEDURAL");
    expect(plan.workflows).toHaveLength(1);
    expect(plan.hasMultipleWorkflows).toBe(false);
    expect(plan.missingProcedure).toBe(false);
    expect(plan.modules).toEqual(["Billing"]);
  });

  it("adds no structural instructions — the ordinary prompt is unchanged", () => {
    expect(renderAnswerPlan(plan)).toBe("");
  });
});

describe("multiple documented workflows", () => {
  const plan = buildAnswerPlan("how do I take a bill payment", [
    snippet({ id: "manual", title: "Manual payment", module: "Billing", procedure: "1. Open Billing\n2. Press Pay" }),
    snippet({ id: "online", title: "Online gateway payment", module: "Billing", procedure: "1. Customer pays\n2. Settles" }),
    snippet({ id: "note", title: "Payment statuses", answer: "A paid bill shows as Paid." }),
  ]);

  it("detects both, and keeps the non-procedural entry as supporting material", () => {
    expect(plan.workflows.map((w) => w.id)).toEqual(["manual", "online"]);
    expect(plan.hasMultipleWorkflows).toBe(true);
    expect(plan.supportingTitles).toEqual(["Payment statuses"]);
  });

  it("instructs the model to present them separately and never merge them", () => {
    const guidance = renderAnswerPlan(plan);
    expect(guidance).toContain("MORE THAN ONE DOCUMENTED WAY");
    expect(guidance).toContain("Manual payment");
    expect(guidance).toContain("Online gateway payment");
    expect(guidance).toMatch(/NEVER interleave/);
  });

  it("carries that instruction into the actual prompt", () => {
    const prompt = buildFallbackPrompt({
      customerMessage: "how do I take a bill payment",
      groupName: null,
      knowledge: [snippet({ procedure: "1. a" }), snippet({ id: "b", procedure: "1. b" })],
      planGuidance: renderAnswerPlan(plan),
    });
    expect(prompt.systemPrompt).toContain("MORE THAN ONE DOCUMENTED WAY");
    // The existing safety rule must survive alongside it.
    expect(prompt.systemPrompt).toContain("NEVER INVENT A STEP");
  });
});

describe("missing procedure", () => {
  const plan = buildAnswerPlan("how do I upgrade a package", [
    snippet({ id: "thin", title: "Packages", answer: "Package upgrade is available." }),
  ]);

  it("flags that a how-to question has no documented steps", () => {
    expect(plan.missingProcedure).toBe(true);
    expect(plan.workflows).toHaveLength(0);
    expect(plan.evidenceCount).toBe(1);
  });

  it("tells the model to say so rather than assemble a likely sequence", () => {
    const guidance = renderAnswerPlan(plan);
    expect(guidance).toContain("NO DOCUMENTED STEPS");
    expect(guidance).toMatch(/not documented/i);
  });

  it("does not flag a FACTUAL question that simply has no steps", () => {
    const factual = buildAnswerPlan("what are your office hours", [snippet({ answer: "10am to 7pm." })]);
    expect(factual.missingProcedure).toBe(false);
    expect(renderAnswerPlan(factual)).toBe("");
  });
});

describe("grounding validation", () => {
  const noStepsPlan = buildAnswerPlan("how do I upgrade a package", [
    snippet({ answer: "Package upgrade is available." }),
  ]);

  it("blocks an invented numbered procedure when no evidence carried steps", () => {
    const invented = "Sure!\n1. Open Billing\n2. Choose Package\n3. Click Upgrade\n4. Confirm";
    const verdict = validateGrounding(invented, noStepsPlan);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("INVENTED_PROCEDURE");
  });

  it("blocks it when written with Bengali numerals too", () => {
    const invented = "অবশ্যই।\n১. Billing এ যান\n২. Package নির্বাচন করুন\n৩. Confirm করুন";
    expect(validateGrounding(invented, noStepsPlan).ok).toBe(false);
  });

  it("allows an honest answer that gives no steps", () => {
    const honest =
      "Package upgrade is available, but the exact steps are not documented here — a colleague will confirm them for you.";
    expect(validateGrounding(honest, noStepsPlan).ok).toBe(true);
  });

  it("allows numbered steps when evidence genuinely documented them", () => {
    const grounded = buildAnswerPlan("how do I record a payment", [
      snippet({ procedure: "1. Open Billing\n2. Press Pay" }),
    ]);
    const reply = "Of course.\n1. Open Billing\n2. Press Pay";
    expect(validateGrounding(reply, grounded).ok).toBe(true);
  });

  it("allows a numbered list in a FACTUAL answer — it is not a procedure", () => {
    const factual = buildAnswerPlan("what payment methods do you accept", [
      snippet({ answer: "Cash and bKash are accepted." }),
    ]);
    const reply = "We accept:\n1. Cash\n2. bKash";
    expect(validateGrounding(reply, factual).ok).toBe(true);
  });

  it("does not trip on a single incidental numbered line", () => {
    expect(validateGrounding("You can do this from step 1. of the billing guide.", noStepsPlan).ok).toBe(true);
  });
});
