import { prisma } from "../db.js";
import { createKnowledgeItem } from "@support-automation/db";
import type { AiClient } from "@support-automation/ai-client";
import {
  ForgeClient,
  ForgeRequestError,
  checkKnowledgeEntrySafety,
  isForgeConfigured,
  loadForgeConfigFromEnv,
} from "@support-automation/forge-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { parseKnowledgeRecords } from "../knowledge/groupKnowledgePrompt.js";
import { buildResearchPrompt, selectModuleForQuestion } from "../forge/forgePrompts.js";
import { readModuleSources, getForgeSettings } from "../forge/forgeKnowledgeJob.js";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

/**
 * Answering a product question nobody has written down yet, by going and finding out.
 *
 * When a customer asks something the verified knowledge base does not cover, the ordinary path
 * hands the conversation to a person and — separately, in the background — queues the question to
 * be researched so the NEXT customer gets an answer. Under the two Forge response modes that
 * research runs immediately instead, and its result answers the customer who is waiting.
 *
 * The important design decision is what this returns. It does NOT produce a reply. It produces
 * GROUNDING — sanitised knowledge entries — which the normal prompt then answers from, exactly as
 * if a human had written those entries months ago. That matters for three reasons:
 *
 *  - Raw source code never reaches the prompt that drafts a customer reply. The disclosure rule
 *    exists precisely to prevent that arrangement, and routing research through the knowledge
 *    shape preserves it.
 *  - Every existing gate still applies afterwards: the scope classification, the confidence
 *    threshold, the response mode, the send-time safety re-check. Deep answers are not a bypass.
 *  - What was learned is stored, so the same question is answered instantly next time without
 *    reading anything.
 *
 * WHAT ACTUALLY GATES THIS. `AiSettings.aiResponseMode` being `KNOWLEDGE_PLUS_FORGE` or
 * `KNOWLEDGE_FORGE_GENERAL` — the check lives in `runAiFallback.ts`, and this module is not
 * called under the other two modes. There is no `deepAnswerEnabled` column; this comment named
 * one for a long time and no such setting has ever existed, which would send anyone looking for
 * the switch to a screen that does not have it. Two further gates are enforced here rather than
 * by the caller: the Forge integration must be configured, and an admin must have enabled it and
 * pointed it at a project.
 */

/** Below this the model is guessing from code it did not really understand. */
const MIN_CONFIDENCE_TO_USE = 60;
/** One question deserves a couple of facts, not a survey of the module. */
const MAX_ENTRIES = 3;

export interface DeepAnswerResult {
  /** Sanitised, storable knowledge to ground the reply with. Empty means "no better off". */
  snippets: KnowledgeSnippet[];
  /** Set when research ran but produced nothing usable — for the decision's audit trail. */
  reason?: string;
}

/**
 * Researches one customer question against the product's own source and returns what it learned.
 *
 * Never throws: the caller is mid-conversation, and a research failure must leave the ordinary
 * handover path intact rather than turning into an error the customer sees.
 */
export async function researchForCustomerQuestion(params: {
  question: string;
  groupId: string | null;
  client: AiClient;
}): Promise<DeepAnswerResult> {
  if (!isForgeConfigured()) return { snippets: [], reason: "FORGE_NOT_CONFIGURED" };

  try {
    const settings = await getForgeSettings();
    // Deliberately requires the Forge integration to be enabled and pointed at a project. This
    // reads that project's source; turning on a deep-answer switch should not quietly start
    // reading a repository the admin never connected.
    if (!settings.enabled || !settings.forgeProjectId) return { snippets: [], reason: "FORGE_DISABLED" };

    const forge = new ForgeClient(loadForgeConfigFromEnv());
    const modules = await forge.listKnowledgeModules(settings.forgeProjectId);
    const module = selectModuleForQuestion(params.question, modules);
    if (!module) return { snippets: [], reason: "NO_MATCHING_MODULE" };

    const sources = await readModuleSources(forge, settings.forgeProjectId, module);
    // A module whose paths do not resolve produces nothing, deliberately: given a name and no
    // source, the model invents a plausible guide. That has been observed.
    if (sources.length === 0) return { snippets: [], reason: "NO_READABLE_SOURCE" };

    const prompt = buildResearchPrompt({ question: params.question, moduleName: module.name, sources });
    const completion = await params.client.complete({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxTokens: prompt.maxTokens,
      temperature: prompt.temperature,
    });

    const extracted = parseKnowledgeRecords(completion.text ?? "")
      .filter((entry) => entry.confidence >= MIN_CONFIDENCE_TO_USE)
      .slice(0, MAX_ENTRIES);
    if (extracted.length === 0) return { snippets: [], reason: "NOTHING_FOUND" };

    const snippets: KnowledgeSnippet[] = [];
    let blocked = 0;

    for (const entry of extracted) {
      // The same mechanical gate the offline Forge jobs use. It runs here too — this is the one
      // path where an entry could reach a customer in the same breath as being written, so it is
      // the last place that should trust the prompt to have behaved.
      const verdict = checkKnowledgeEntrySafety(entry);
      if (!verdict.safe) {
        blocked += 1;
        await logSystemEvent("WARN", "ai-fallback", "Deep answer discarded — would have exposed internals", {
          question: params.question.slice(0, 120),
          violations: verdict.violations.join(", "),
        });
        continue;
      }

      // Stored so the next customer is answered instantly from the knowledge base with no reading
      // at all. Verified, because it is about to be said to a customer: recording it as unverified
      // while sending it would be incoherent, and would also mean it could never be reused, which
      // defeats the point. The safety gate above is what earns that, and the setting's own
      // description says plainly that this is the trade being made.
      const stored = await createKnowledgeItem({
        title: entry.title,
        category: entry.category,
        question: entry.question ?? params.question,
        answer: entry.answer,
        procedure: entry.procedure,
        module: module.name,
        software: "ISPDIGITAL",
        source: "DEEP_ANSWER",
        sourceLabel: `Researched live — ${module.name}`,
        // Carries a group, so `createKnowledgeItem` derives GROUP scope from it — and that is the
        // behaviour that matters here. This was written with `humanVerified: true` and no scope at
        // all, so a fact researched to answer ONE group's question became retrievable in every
        // other group the instant it was stored. It answers the customer who asked, and a person
        // promotes it to GLOBAL if it turns out to be true of the product rather than of them.
        sourceGroupId: params.groupId,
        confidence: entry.confidence,
        aiGenerated: true,
        humanVerified: true,
      }, prisma);

      snippets.push({
        id: stored.id,
        title: entry.title,
        question: entry.question ?? params.question,
        answer: entry.answer,
        procedure: entry.procedure,
        module: module.name,
        // Version 1, because `createKnowledgeItem` has just written it — carried into the evidence
        // snapshot so a reply grounded on live research is as explainable as any other.
        version: 1,
        scope: "GROUP",
        fromSameGroup: true,
      });
    }

    if (snippets.length === 0) return { snippets: [], reason: blocked > 0 ? "ALL_BLOCKED" : "NOTHING_FOUND" };

    await logSystemEvent("INFO", "ai-fallback", "Answered a question by researching the product source", {
      module: module.slug,
      learned: snippets.length,
      blocked,
    });
    return { snippets };
  } catch (err) {
    const reason = err instanceof ForgeRequestError ? "FORGE_UNAVAILABLE" : "RESEARCH_FAILED";
    await logSystemEvent("WARN", "ai-fallback", "Deep answer research failed", {
      reason,
      error: (err as Error).message,
    });
    return { snippets: [], reason };
  }
}
