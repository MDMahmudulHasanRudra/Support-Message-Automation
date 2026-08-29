import { describe, expect, it } from "vitest";
import {
  MAX_TRANSCRIPT_CHARS,
  buildGroupKnowledgePrompt,
  parseKnowledgeRecords,
} from "../knowledge/groupKnowledgePrompt.js";

/**
 * Pure unit test — no database, no network, no Prisma client. The module under test imports
 * only a type from @prisma/client, which is erased at runtime, so this file is safe to run
 * anywhere (unlike this directory's *.integration.test.ts files).
 */

function line(body: string, isTeamMember = false) {
  return { at: new Date("2026-08-01T10:00:00Z"), speaker: isTeamMember ? "SUPPORT" : "CUSTOMER", isTeamMember, body };
}

describe("buildGroupKnowledgePrompt", () => {
  it("labels each turn by role and never leaks the sender's identity", () => {
    const prompt = buildGroupKnowledgePrompt({
      groupName: "Retail POS — Chattogram",
      lines: [line("my printer is not working"), line("Please reinstall the driver", true)],
    });

    expect(prompt.userPrompt).toContain("[CUSTOMER] my printer is not working");
    expect(prompt.userPrompt).toContain("[SUPPORT] Please reinstall the driver");
    // The transcript is built from role + body only, so no name or number can reach the model.
    expect(prompt.userPrompt).not.toMatch(/\+?\d{7,}/);
  });

  it("caps the transcript so one very long group cannot blow the context window", () => {
    const prompt = buildGroupKnowledgePrompt({
      groupName: "Busy group",
      lines: Array.from({ length: 5000 }, () => line("a reasonably long support message about printers")),
    });

    // The cap applies to the transcript; the surrounding instructions add a little on top.
    expect(prompt.userPrompt.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 2000);
  });

  it("asks for a deterministic, parseable format", () => {
    const prompt = buildGroupKnowledgePrompt({ groupName: "g", lines: [line("hi")] });
    expect(prompt.temperature).toBe(0);
    expect(prompt.userPrompt).toContain("TITLE:");
    expect(prompt.userPrompt).toContain("CONFIDENCE:");
  });
});

describe("parseKnowledgeRecords", () => {
  it("parses several records separated by the record marker", () => {
    const entries = parseKnowledgeRecords(
      [
        "TITLE: Receipt printer offline after update",
        "CATEGORY: TROUBLESHOOTING",
        "QUESTION: Why did my receipt printer stop working after the update?",
        "ANSWER: Reinstall the printer driver, then restart the POS terminal.",
        "CONFIDENCE: 88",
        "---",
        "TITLE: Stock sync runs nightly",
        "CATEGORY: WORKFLOW",
        "QUESTION: NONE",
        "ANSWER: Inventory syncs once per night at 2am; same-day edits appear the next morning.",
        "CONFIDENCE: 72",
      ].join("\n"),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ category: "TROUBLESHOOTING", confidence: 88 });
    expect(entries[0]!.answer).toContain("Reinstall the printer driver");
    // QUESTION: NONE is a real absence, not the literal string.
    expect(entries[1]!.question).toBeNull();
  });

  it("returns nothing for the explicit NOTHING reply", () => {
    expect(parseKnowledgeRecords("NOTHING")).toEqual([]);
    expect(parseKnowledgeRecords("  nothing  ")).toEqual([]);
  });

  it("returns nothing for an empty response", () => {
    expect(parseKnowledgeRecords("")).toEqual([]);
  });

  it("drops a record with an unknown category rather than guessing one", () => {
    const entries = parseKnowledgeRecords(
      ["TITLE: Something", "CATEGORY: BANANA", "ANSWER: An answer.", "CONFIDENCE: 90"].join("\n"),
    );
    expect(entries).toEqual([]);
  });

  it("drops a record missing a title or an answer", () => {
    expect(parseKnowledgeRecords("CATEGORY: FAQ\nANSWER: orphan\nCONFIDENCE: 90")).toEqual([]);
    expect(parseKnowledgeRecords("TITLE: orphan\nCATEGORY: FAQ\nCONFIDENCE: 90")).toEqual([]);
  });

  it("treats a missing confidence as zero so the caller's threshold decides", () => {
    const entries = parseKnowledgeRecords(
      ["TITLE: Untrusted", "CATEGORY: FAQ", "ANSWER: Some answer."].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.confidence).toBe(0);
  });

  it("clamps an out-of-range confidence", () => {
    const high = parseKnowledgeRecords("TITLE: t\nCATEGORY: FAQ\nANSWER: a\nCONFIDENCE: 150");
    const low = parseKnowledgeRecords("TITLE: t\nCATEGORY: FAQ\nANSWER: a\nCONFIDENCE: -20");
    expect(high[0]!.confidence).toBe(100);
    expect(low[0]!.confidence).toBe(0);
  });

  it("keeps every complete record when the model trails off mid-answer", () => {
    // The whole reason for a record separator rather than JSON: a truncated response still
    // yields the records that did complete.
    const entries = parseKnowledgeRecords(
      [
        "TITLE: First",
        "CATEGORY: FAQ",
        "ANSWER: Complete answer.",
        "CONFIDENCE: 90",
        "---",
        "TITLE: Second, cut off",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("First");
  });

  it("keeps a multi-line answer intact", () => {
    const entries = parseKnowledgeRecords(
      ["TITLE: Steps", "CATEGORY: SOP", "ANSWER: Step one.\nStep two.\nStep three.", "CONFIDENCE: 80"].join("\n"),
    );
    expect(entries[0]!.answer).toBe("Step one.\nStep two.\nStep three.");
  });
});
