import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import type { AiClient } from "@support-automation/ai-client";
import { researchForCustomerQuestion } from "../aiFallback/deepAnswer.js";

/**
 * Answering a product question by researching it while the customer waits.
 *
 * The thing worth testing is not that it can find an answer — it is that it cannot leak one. This
 * is the only path in the product where a model reads source code and the result can reach a
 * customer in the same breath, so the disclosure gate standing between those two is the whole
 * safety story. If it lets a table name through here, it reaches a customer directly.
 *
 * The Forge side is not reachable from tests (it needs a live API and a connected project), so
 * these exercise the gate that guards the boundary, plus the switches that decide whether any of
 * it runs at all.
 */

const stubClient = (text: string): AiClient => ({
  complete: async () => ({ text, tokensUsed: 10, providerId: "test", modelId: "test" }),
});

beforeAll(async () => {
  await prisma.forgeSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
});

afterEach(async () => {
  await prisma.aiKnowledgeItem.deleteMany({ where: { source: "DEEP_ANSWER" } });
  await prisma.forgeSettings.update({
    where: { id: "global" },
    data: { enabled: false, forgeProjectId: null },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("it does not run unless it is meant to", () => {
  it("does nothing when the Forge integration is disabled", async () => {
    // Turning on a deep-answer switch must not quietly start reading a repository nobody
    // connected — the source it reads belongs to a project an admin chose.
    await prisma.forgeSettings.update({
      where: { id: "global" },
      data: { enabled: false, forgeProjectId: "some-project" },
    });

    const result = await researchForCustomerQuestion({
      question: "How do I void an invoice?",
      groupId: null,
      client: stubClient("irrelevant"),
    });

    // Asserts the contract — nothing researched, nothing stored — rather than the diagnostic
    // string. The reason differs by environment (FORGE_NOT_CONFIGURED without credentials,
    // FORGE_DISABLED with them), and pinning it made this pass alone and fail in the full suite,
    // which is a test describing its own environment rather than the behaviour.
    expect(result.snippets).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("does nothing when no project has been chosen", async () => {
    await prisma.forgeSettings.update({ where: { id: "global" }, data: { enabled: true, forgeProjectId: null } });

    const result = await researchForCustomerQuestion({
      question: "How do I void an invoice?",
      groupId: null,
      client: stubClient("irrelevant"),
    });

    expect(result.snippets).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });

  it("stores nothing when it produces nothing", async () => {
    const before = await prisma.aiKnowledgeItem.count();
    await researchForCustomerQuestion({
      question: "anything",
      groupId: null,
      client: stubClient("NOTHING"),
    });
    expect(await prisma.aiKnowledgeItem.count()).toBe(before);
  });
});

describe("it never returns unreachable Forge as an error to the customer", () => {
  it("reports a reason instead of throwing when Forge cannot be reached", async () => {
    // The customer is mid-conversation. A research failure has to leave the ordinary handover
    // intact, not surface as an error.
    await prisma.forgeSettings.update({
      where: { id: "global" },
      data: { enabled: true, forgeProjectId: "definitely-not-a-real-project" },
    });

    const result = await researchForCustomerQuestion({
      question: "How do I generate a bill?",
      groupId: null,
      client: stubClient("irrelevant"),
    });

    expect(result.snippets).toHaveLength(0);
    expect(result.reason).toBeTruthy();
  });
});

/**
 * The gate itself, exercised directly against the strings that matter. These are the exact
 * failures that reached production knowledge earlier in this project's life, and the reason the
 * mechanical check exists rather than trusting the prompt.
 */
describe("the disclosure gate stands between research and the customer", () => {
  it("rejects an answer naming an internal record", async () => {
    const { checkKnowledgeEntrySafety } = await import("@support-automation/forge-client");
    expect(
      checkKnowledgeEntrySafety({
        title: "Reversing a migration",
        answer: "This will create a CustomerBillMaster for each customer.",
      }).safe,
    ).toBe(false);
  });

  it("rejects an answer naming a source file", async () => {
    const { checkKnowledgeEntrySafety } = await import("@support-automation/forge-client");
    expect(
      checkKnowledgeEntrySafety({ title: "Billing", answer: "See BillingController.cs for the logic." }).safe,
    ).toBe(false);
  });

  it("allows the same thing said the way a customer would hear it", async () => {
    // A gate that also blocked real answers would get switched off, and an off gate protects
    // nothing — so this direction matters exactly as much as the two above.
    const { checkKnowledgeEntrySafety } = await import("@support-automation/forge-client");
    expect(
      checkKnowledgeEntrySafety({
        title: "Voiding an invoice",
        question: "How do I cancel an invoice raised by mistake?",
        answer:
          "Open the invoice and choose Void. It stays visible so your records stay complete, but it no longer counts towards the customer's due amount.",
      }).safe,
    ).toBe(true);
  });
});
