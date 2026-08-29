import { describe, expect, it } from "vitest";
import { CHUNK_TARGET_CHARS, buildImportPrompt, chunkDocument } from "../knowledge/importPrompt.js";
import { parseKnowledgeRecords } from "../knowledge/groupKnowledgePrompt.js";

/** Pure unit test — no database, no network. */

describe("chunkDocument", () => {
  it("keeps a short document as one chunk", () => {
    expect(chunkDocument("Service tracking lets you create requests.")).toHaveLength(1);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n\n  ")).toEqual([]);
  });

  it("splits a long document and loses none of its text", () => {
    const paragraph = "Configure the router before enabling PPPoE. ".repeat(40); // ~1.7k chars
    const doc = Array.from({ length: 12 }, (_, i) => `Section ${i}\n\n${paragraph}`).join("\n\n");

    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThan(1);

    // Nothing may be dropped: joining the chunks back must contain every section heading.
    const rejoined = chunks.join("\n\n");
    for (let i = 0; i < 12; i++) {
      expect(rejoined).toContain(`Section ${i}`);
    }
  });

  it("breaks between paragraphs rather than mid-sentence", () => {
    const doc = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${"detail ".repeat(60)}`).join("\n\n");
    for (const chunk of chunkDocument(doc)) {
      // A chunk that began mid-paragraph would start with a lowercase fragment.
      expect(chunk.trimStart().startsWith("Paragraph")).toBe(true);
    }
  });

  it("splits a single giant paragraph that has no blank lines at all", () => {
    // A wall of text pasted out of a PDF is the realistic worst case: no paragraph breaks to
    // split on, so it has to fall back to sentence boundaries or it can never be chunked.
    const wall = "This sentence describes a configuration step. ".repeat(400);
    const chunks = chunkDocument(wall);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 200);
    }
  });

  it("folds a tiny trailing fragment into its neighbour instead of spending a call on it", () => {
    const body = "Detail sentence. ".repeat(500);
    const chunks = chunkDocument(`${body}\n\nEnd.`);
    expect(chunks.every((chunk) => chunk.length > 100)).toBe(true);
  });
});

describe("buildImportPrompt", () => {
  it("tells the model to preserve the document rather than generalise it", () => {
    const prompt = buildImportPrompt({
      label: "MikroTik Integration Guide",
      module: null,
      chunk: "Enable the API service before connecting.",
      chunkIndex: 0,
      chunkCount: 1,
    });

    expect(prompt.systemPrompt).toMatch(/Preserve what the document says/i);
    expect(prompt.systemPrompt).toMatch(/do not add/i);
    expect(prompt.temperature).toBe(0);
    expect(prompt.userPrompt).toContain("MikroTik Integration Guide");
  });

  it("pins the module when the operator supplied one", () => {
    const prompt = buildImportPrompt({
      label: "Guide",
      module: "MikroTik Integration",
      chunk: "text",
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(prompt.userPrompt).toContain("MODULE: MikroTik Integration");
  });

  it("says where a section sits in a multi-part document, and stays quiet for a single one", () => {
    const multi = buildImportPrompt({ label: "G", module: null, chunk: "t", chunkIndex: 2, chunkCount: 9 });
    const single = buildImportPrompt({ label: "G", module: null, chunk: "t", chunkIndex: 0, chunkCount: 1 });
    expect(multi.userPrompt).toContain("Section 3 of 9");
    expect(single.userPrompt).not.toContain("Section 1 of 1");
  });

  it("asks for the same record format the shared parser reads", () => {
    const prompt = buildImportPrompt({ label: "G", module: null, chunk: "t", chunkIndex: 0, chunkCount: 1 });
    for (const field of ["TITLE:", "CATEGORY:", "MODULE:", "QUESTION:", "ANSWER:", "CONFIDENCE:"]) {
      expect(prompt.userPrompt).toContain(field);
    }
  });
});

describe("parseKnowledgeRecords — MODULE field", () => {
  it("reads the module out of a record", () => {
    const entries = parseKnowledgeRecords(
      [
        "TITLE: Suspending a customer",
        "CATEGORY: WORKFLOW",
        "MODULE: Customer Management",
        "QUESTION: What happens when a customer is suspended?",
        "ANSWER: The PPPoE profile is disabled automatically when MikroTik integration is active.",
        "CONFIDENCE: 92",
      ].join("\n"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]!.module).toBe("Customer Management");
    // The answer must stop at MODULE/CONFIDENCE, not swallow them.
    expect(entries[0]!.answer).toBe(
      "The PPPoE profile is disabled automatically when MikroTik integration is active.",
    );
  });

  it("treats a missing or NONE module as absent", () => {
    const withNone = parseKnowledgeRecords("TITLE: t\nCATEGORY: FAQ\nMODULE: NONE\nANSWER: a\nCONFIDENCE: 80");
    const without = parseKnowledgeRecords("TITLE: t\nCATEGORY: FAQ\nANSWER: a\nCONFIDENCE: 80");
    expect(withNone[0]!.module).toBeNull();
    expect(without[0]!.module).toBeNull();
  });

  it("keeps a multi-line answer intact when MODULE follows it", () => {
    const entries = parseKnowledgeRecords(
      ["TITLE: Steps", "CATEGORY: SOP", "ANSWER: One.\nTwo.\nThree.", "MODULE: Billing", "CONFIDENCE: 80"].join("\n"),
    );
    expect(entries[0]!.answer).toBe("One.\nTwo.\nThree.");
    expect(entries[0]!.module).toBe("Billing");
  });
});
