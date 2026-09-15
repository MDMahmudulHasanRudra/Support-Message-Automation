import { describe, expect, it } from "vitest";
import { isMediaOnlyBody } from "@support-automation/shared";
import {
  buildKnowledgeImportTemplateRows,
  isTemplateExampleRow,
  parseKnowledgeImportRows,
} from "@support-automation/shared";
import { isNonAuthoritativePath } from "../forge/forgeKnowledgeJob.js";

/**
 * Regression cover for the rule that an EXAMPLE must never become customer-facing fact.
 *
 * Each block below corresponds to a path an audit found could carry illustrative material into
 * the knowledge base, where `humanVerified: true` would make it retrievable and quotable to a
 * customer as this company's policy.
 */

describe("the downloadable import template cannot become knowledge", () => {
  it("asserts no product fact", () => {
    const rows = buildKnowledgeImportTemplateRows();
    const text = JSON.stringify(rows).toLowerCase();

    // The template used to ship "Support is staffed 9am to 10pm, seven days a week" and a
    // concrete PPPoE reset path. Both were invented, and both imported as valid rows.
    expect(text).not.toContain("9am");
    expect(text).not.toContain("seven days a week");
    expect(text).not.toContain("pppoe");
    expect(text).not.toContain("reset password");
  });

  it("marks every sample row so it is recognisable as an example", () => {
    for (const row of buildKnowledgeImportTemplateRows()) {
      const values = Object.values(row).join(" ");
      expect(values).toContain("EXAMPLE ROW");
    }
  });

  it("refuses to import the template if it is uploaded unedited", () => {
    const { results } = parseKnowledgeImportRows(buildKnowledgeImportTemplateRows());
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.outcome).toBe("INVALID");
      expect(result.row).toBeNull();
    }
  });

  it("recognises a marked row directly", () => {
    expect(isTemplateExampleRow("EXAMPLE ROW — DELETE BEFORE IMPORTING. x", "anything")).toBe(true);
    expect(isTemplateExampleRow("How do I pay a bill?", "Open Billing and choose Pay.")).toBe(false);
  });
});

describe("Forge never ingests non-authoritative source", () => {
  it("skips tests, mocks, fixtures, seeds, samples, demos, drafts and templates", () => {
    for (const path of [
      "ISPDIGITAL/tests/BillingTests.cs",
      "src/SeedData.cs",
      "src/DemoDataGenerator.cs",
      "src/MockRepository.cs",
      "src/FakeBillingService.cs",
      "x/TestHelper.cs",
      "docs/sample-billing-walkthrough.md",
      "docs/draft-guide.md",
      "x/__mocks__/api.ts",
      "app/fixtures/customer.json",
      "docs/templates/faq.md",
      "deprecated/old-billing.md",
      "Billing.Tests.cs",
    ]) {
      expect(isNonAuthoritativePath(path), path).toBe(true);
    }
  });

  it("does not block real documentation that merely contains a keyword as a substring", () => {
    // These are the traps. "latest" contains "test"; "specification" starts with "spec";
    // "contest" and "Protestant" contain "test". All are legitimate and must survive.
    for (const path of [
      "ISPDIGITAL/docs/user-guides/billing.md",
      "ISPDIGITAL/docs/user-guides/package-upgrade.md",
      "src/Controllers/BillingController.cs",
      "docs/latest-features.md",
      "docs/greatest-hits.md",
      "docs/specification.md",
      "src/Specification.cs",
      "docs/testimonials.md",
      "docs/contest-rules.md",
      "src/Protestant.cs",
    ]) {
      expect(isNonAuthoritativePath(path), path).toBe(false);
    }
  });
});

describe("media the system cannot read is not answered as if it were text", () => {
  it("treats a bare placeholder as media-only", () => {
    for (const body of ["[Image]", "[Voice message]", "[Sticker]", "[Document]", " [Image] "]) {
      expect(isMediaOnlyBody(body), body).toBe(true);
    }
  });

  it("does not catch a captioned image — the caption is the customer's real question", () => {
    expect(isMediaOnlyBody("[Image] amar bill ashe nai")).toBe(false);
    expect(isMediaOnlyBody("[Document] invoice.pdf")).toBe(false);
  });

  it("leaves ordinary text alone", () => {
    expect(isMediaOnlyBody("আমার বিল কত")).toBe(false);
    expect(isMediaOnlyBody("")).toBe(false);
    expect(isMediaOnlyBody(null)).toBe(false);
  });
});
