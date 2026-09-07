import { describe, expect, it } from "vitest";
import {
  buildModuleGuidePrompt,
  buildResearchPrompt,
  buildUserGuidePrompt,
  selectModuleForQuestion,
} from "../forge/forgePrompts.js";
import { ALLOWED_KNOWLEDGE_CATEGORIES, parseKnowledgeRecords } from "../knowledge/groupKnowledgePrompt.js";

/** Pure unit tests — no database, no network, no model. */

const SOURCES = [{ path: "Some/Path/BillingController.cs", content: "public class BillingController { }" }];

describe("every Forge prompt states the disclosure rules", () => {
  const prompts = {
    "user guide": buildUserGuidePrompt({
      documentTitle: "Monthly Billing",
      moduleHint: null,
      chunk: "text",
      chunkIndex: 0,
      chunkCount: 1,
    }),
    "module guide": buildModuleGuidePrompt({ moduleName: "Billing", moduleSummary: null, sources: SOURCES }),
    research: buildResearchPrompt({ question: "How do I void an invoice?", moduleName: "Billing", sources: SOURCES }),
  };

  for (const [name, prompt] of Object.entries(prompts)) {
    it(`${name}: forbids code, schema, endpoints and credentials`, () => {
      const system = prompt.systemPrompt.toLowerCase();
      expect(system).toContain("source code");
      expect(system).toContain("database tables");
      expect(system).toMatch(/endpoints/);
      expect(system).toMatch(/credentials|tokens/);
    });

    it(`${name}: says who the audience is`, () => {
      expect(prompt.systemPrompt.toLowerCase()).toContain("never writing for a");
    });

    it(`${name}: prefers writing nothing over writing something unsafe`, () => {
      expect(prompt.systemPrompt.toLowerCase()).toMatch(/do not write a\s+record|writing no records|not there/is);
    });

    it(`${name}: asks for zero temperature`, () => {
      // These jobs report what the material says. Sampling variety would be a bug, not a feature.
      expect(prompt.temperature).toBe(0);
    });
  }
});

describe("guide prompts refuse to invent troubleshooting", () => {
  // Sixteen auto-verified entries in the live knowledge base were invented troubleshooting of
  // exactly this shape — "check your permissions, refresh the page, contact support" — for
  // failures the source documents never described. They are findable, so they were answering
  // real customers instead of letting the question reach a person.
  const guidePrompts = {
    "user guide": buildUserGuidePrompt({
      documentTitle: "Monthly Billing",
      moduleHint: null,
      chunk: "text",
      chunkIndex: 0,
      chunkCount: 1,
    }),
    "module guide": buildModuleGuidePrompt({ moduleName: "Billing", moduleSummary: null, sources: SOURCES }),
  };

  for (const [name, prompt] of Object.entries(guidePrompts)) {
    it(`${name}: forbids a failure record the material does not describe`, () => {
      const system = prompt.systemPrompt.toLowerCase();
      expect(system).toContain("what to do when something goes wrong");
      expect(system).toContain("unless the");
    });

    it(`${name}: names the boilerplate it must not produce`, () => {
      // Naming the exact phrases matters: "do not be generic" is advice, a list is an instruction.
      const system = prompt.systemPrompt.toLowerCase();
      expect(system).toContain("check your permissions");
      expect(system).toContain("refresh");
      expect(system).toContain("contact support");
    });

    it(`${name}: says an ungrounded answer is worse than none`, () => {
      expect(prompt.systemPrompt.toLowerCase()).toContain("worse than no answer");
    });

    it(`${name}: removes the pressure to fill a quota`, () => {
      expect(prompt.systemPrompt.toLowerCase()).toContain("no quota");
    });
  }
});

describe("record format stays in step with the shared parser", () => {
  it("asks only for categories the parser accepts", () => {
    const prompt = buildUserGuidePrompt({
      documentTitle: "G",
      moduleHint: null,
      chunk: "t",
      chunkIndex: 0,
      chunkCount: 1,
    });
    for (const category of ALLOWED_KNOWLEDGE_CATEGORIES) {
      expect(prompt.userPrompt).toContain(category);
    }
  });

  it("produces a shape parseKnowledgeRecords can actually read", () => {
    // Guards the seam between the two files: if the requested field names drift, every Forge sync
    // silently produces zero entries and nothing errors.
    const modelReply = [
      "TITLE: Voiding an invoice",
      "CATEGORY: WORKFLOW",
      "MODULE: Billing",
      "QUESTION: How do I cancel an invoice that was raised by mistake?",
      "ANSWER: Open the invoice and choose Void. It stays visible for your records but no longer counts as due.",
      "CONFIDENCE: 90",
    ].join("\n");

    const entries = parseKnowledgeRecords(modelReply);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: "Voiding an invoice",
      category: "WORKFLOW",
      module: "Billing",
      confidence: 90,
    });
  });
});

describe("buildUserGuidePrompt", () => {
  it("tells the model to preserve the document rather than improve it", () => {
    const prompt = buildUserGuidePrompt({
      documentTitle: "Monthly Billing",
      moduleHint: "Billing",
      chunk: "text",
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(prompt.systemPrompt).toMatch(/Preserve what the document says/i);
    expect(prompt.userPrompt).toContain("Monthly Billing");
    expect(prompt.userPrompt).toContain("MODULE: Billing");
  });

  it("locates a section in a multi-part document, and stays quiet for a single one", () => {
    const multi = buildUserGuidePrompt({
      documentTitle: "G",
      moduleHint: null,
      chunk: "t",
      chunkIndex: 2,
      chunkCount: 9,
    });
    const single = buildUserGuidePrompt({
      documentTitle: "G",
      moduleHint: null,
      chunk: "t",
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(multi.userPrompt).toContain("section 3 of 9");
    expect(single.userPrompt).not.toContain("section 1 of 1");
  });
});

describe("buildModuleGuidePrompt", () => {
  it("frames the code as the means, not the subject", () => {
    const prompt = buildModuleGuidePrompt({
      moduleName: "Billing",
      moduleSummary: "Invoices and payments.",
      sources: SOURCES,
    });
    // Asking a model to "summarise this code" reliably produces developer documentation.
    expect(prompt.systemPrompt).toMatch(/The code is never the subject/i);
    expect(prompt.userPrompt).toContain("Invoices and payments.");
  });

  it("includes every source it was given", () => {
    const prompt = buildModuleGuidePrompt({
      moduleName: "Billing",
      moduleSummary: null,
      sources: [
        { path: "a.cs", content: "AAA" },
        { path: "b.cs", content: "BBB" },
      ],
    });
    expect(prompt.userPrompt).toContain("AAA");
    expect(prompt.userPrompt).toContain("BBB");
    expect(prompt.userPrompt).toContain("source 2 of 2");
  });

  it("does not put source file paths in the prompt body", () => {
    // Paths are for orientation in the caller, not material for the model to quote back.
    const prompt = buildModuleGuidePrompt({
      moduleName: "Billing",
      moduleSummary: null,
      sources: [{ path: "ISPDIGITAL/Controllers/SecretController.cs", content: "code" }],
    });
    expect(prompt.userPrompt).not.toContain("SecretController.cs");
  });
});

describe("buildResearchPrompt", () => {
  it("permits — and names — the outcome of finding no answer", () => {
    const prompt = buildResearchPrompt({ question: "What is the refund window?", moduleName: "Billing", sources: SOURCES });
    expect(prompt.systemPrompt).toMatch(/writing no records at all/i);
    expect(prompt.systemPrompt).toMatch(/Do not guess/i);
    expect(prompt.userPrompt).toContain("What is the refund window?");
  });

  it("caps how much it may write, since it is answering one question", () => {
    const prompt = buildResearchPrompt({ question: "q?", moduleName: null, sources: SOURCES });
    expect(prompt.userPrompt).toMatch(/at most two records/i);
  });
});

describe("selectModuleForQuestion", () => {
  const modules = [
    { name: "Billing, Invoicing & Payments", slug: "billing-payments", summary: "Customer bills, invoices, payment collection." },
    { name: "Mikrotik, OLT & Network", slug: "mikrotik-network", summary: "Routers, network devices and connectivity." },
    { name: "HR & Payroll", slug: "hr-payroll", summary: "Employees, salary and attendance." },
  ];

  it("routes a billing question to billing", () => {
    expect(selectModuleForQuestion("How do I generate an invoice for this month?", modules)?.slug).toBe("billing-payments");
  });

  it("routes a network question to the network module", () => {
    expect(selectModuleForQuestion("My mikrotik router keeps disconnecting", modules)?.slug).toBe("mikrotik-network");
  });

  it("returns null when nothing matches, rather than guessing", () => {
    // A wrong module means reading the wrong files and answering confidently from them. The
    // caller treats null as "this is probably not about the product", which is the right answer.
    expect(selectModuleForQuestion("what is the weather tomorrow", modules)).toBeNull();
  });

  it("returns null for an empty question or an empty catalogue", () => {
    expect(selectModuleForQuestion("", modules)).toBeNull();
    expect(selectModuleForQuestion("invoice", [])).toBeNull();
  });

  it("ignores short words so a stray fragment cannot pick a module", () => {
    expect(selectModuleForQuestion("is it on?", modules)).toBeNull();
  });

  it("prefers the module matching more of the question", () => {
    expect(selectModuleForQuestion("employees salary attendance payroll", modules)?.slug).toBe("hr-payroll");
  });
});
