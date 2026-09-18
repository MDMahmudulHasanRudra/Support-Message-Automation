import { createKnowledgeItem, prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import {
  ForgeClient,
  ForgeRequestError,
  checkKnowledgeEntrySafety,
  checkKnowledgeEntrySubstance,
  isForgeConfigured,
  loadForgeConfigFromEnv,
  type ForgeKnowledgeModule,
} from "@support-automation/forge-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { parseKnowledgeRecords, type ExtractedKnowledge } from "../knowledge/groupKnowledgePrompt.js";
import { chunkDocument } from "../knowledge/importPrompt.js";
import { buildModuleGuidePrompt, buildUserGuidePrompt } from "./forgePrompts.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * Teaches this support system about ISPDIGITAL by reading its repository through Softify Forge.
 *
 * Two tiers, run in that order, because they differ in authority:
 *
 *  1. **User guides** — documents the team wrote FOR customers. Authoritative. Published without
 *     review when `autoVerifyUserGuides` is on, which is the admin's recorded decision.
 *  2. **Module guides** — for the product areas nobody has hand-documented, the model reads the
 *     source behind the area and writes a user guide for it. A model's reading of code is
 *     evidence, not fact, so these ALWAYS land unverified regardless of any setting.
 *
 * Both tiers pass every produced entry through `checkKnowledgeSafety()` before it is stored. An
 * entry that mentions code, schema, endpoints or credentials is dropped and counted, never
 * stored — not even as an unverified draft, because a draft is one careless click from being
 * verified.
 *
 * Tier 1 additionally passes `checkKnowledgeSubstance()` before it may be **auto-verified**. The
 * two gates are deliberately different in severity: a disclosure violation is never stored, while
 * a vague entry is stored and merely denied the automatic verification, because it is a draft
 * worth improving rather than a leak. This exists because auto-verified filler is worse than an
 * empty knowledge base — retrieval matches it, which stops the deep-answer research and the
 * handover from ever running. See `knowledgeSubstance.ts`.
 *
 * Each unit of work becomes a `KnowledgeImport` row, reusing the existing import machinery for
 * progress, retry and provenance rather than inventing a parallel one.
 */

/** Below this the model is inferring rather than reporting. Matches the document importer. */
const MIN_CONFIDENCE_TO_STORE = 55;
/** Per-module ceiling, so one enormous controller cannot flood the review queue on its own. */
const MAX_ENTRIES_PER_UNIT = 25;
/**
 * How much source to send for one module. Large enough for a controller plus context, small
 * enough to stay inside a modest context window — the same reasoning as MAX_TRANSCRIPT_CHARS.
 */
const MAX_SOURCE_CHARS_PER_MODULE = 60_000;
/** A single file bigger than this is almost certainly generated or a data dump, not behaviour. */
const MAX_SOURCE_CHARS_PER_FILE = 24_000;

/** Where hand-written, customer-facing documentation lives in the ISPDIGITAL repository. */
const USER_GUIDE_DIRECTORIES = ["ISPDIGITAL Current/docs/user-guides"];
/** Individual documents that are customer-facing but do not sit under the guides directory. */
const USER_GUIDE_FILES = [
  "ISPDIGITAL Current/docs/product-overview.md",
  "ISPDIGITAL Current/docs/ISPDIGITAL-Application-Overview.md",
];

export interface ForgeSyncResult {
  ran: boolean;
  skipped?: string;
  documentsRead?: number;
  modulesRead?: number;
  entriesCreated?: number;
  entriesBlocked?: number;
}

export interface ForgeSettingsRow {
  enabled: boolean;
  projectId: string | null;
  syncUserGuides: boolean;
  syncModuleGuides: boolean;
  autoVerifyUserGuides: boolean;
}

export async function getForgeSettings() {
  // Read first, upsert only when genuinely absent — pipeline/settings.ts's pattern, and for its
  // reason: this is read at the top of a polling loop tick, and an unconditional upsert takes a
  // row lock and writes a tuple every time to discover that nothing has changed.
  const existing = await prisma.forgeSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return prisma.forgeSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

/**
 * Recursively lists every readable file under a directory, bounded so a mistaken path cannot walk
 * an entire repository. Returns paths only; contents are fetched one at a time later.
 */

/**
 * Whether a repository path is non-authoritative — a test, mock, fixture, seed, sample, demo,
 * draft, deprecated or template file — and must not become customer-facing knowledge.
 *
 * Forge reads the product's real repository, and a repository contains far more than the truth
 * about how the shipped product behaves. Before this the ONLY path filters were an image-folder
 * exclusion and a file-extension check, so a `SeedData.cs`, a `*Tests.cs`, a
 * `sample-billing-walkthrough.md` or a `draft-*.md` was read and summarised into a "user guide"
 * exactly like a live one. That matters most on the two paths that do not land in the review
 * queue: tier 1 auto-verifies when `autoVerifyUserGuides` is on, and the live deep-answer research
 * writes verified entries and grounds the reply going out in the same second.
 *
 * Whole path segments and filename stems only, so a legitimate guide is not caught by an
 * unlucky substring — "latest-features.md" contains "test" and must survive.
 */
const NON_AUTHORITATIVE_SEGMENT =
  /(^|[\/_.-])(tests?|specs?|mocks?|stubs?|fixtures?|seeds?|samples?|demos?|examples?|drafts?|deprecated|obsolete|templates?|sandbox|playground)([\/_.-]|$)/i;

/**
 * The CamelCase compounds the segment rule cannot see: `SeedData.cs`, `MockRepository.cs`,
 * `DemoDataGenerator.cs`, `TestHelper.cs` — a keyword glued to the next word with no separator.
 *
 * Deliberately case-SENSITIVE, and that is the whole reason it is a second pattern rather than
 * another branch of the first. Matching case-insensitively here would blocklist `specification.md`
 * ("spec" + "i") and `testimonials.md`, which are ordinary documentation. Requiring a capital
 * immediately after a capitalised keyword matches the compound and nothing else.
 */
const NON_AUTHORITATIVE_COMPOUND =
  /(^|[\/_.-])(Test|Tests|Spec|Mock|Stub|Fixture|Seed|Sample|Demo|Example|Draft|Template|Dummy|Fake)[A-Z]/;

export function isNonAuthoritativePath(path: string): boolean {
  return NON_AUTHORITATIVE_SEGMENT.test(path) || NON_AUTHORITATIVE_COMPOUND.test(path);
}

async function listFilesUnder(
  client: ForgeClient,
  projectId: string,
  root: string,
  maxFiles = 40,
): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];
  let directoriesVisited = 0;

  while (queue.length > 0 && found.length < maxFiles && directoriesVisited < 25) {
    const path = queue.shift()!;
    directoriesVisited += 1;
    let tree;
    try {
      tree = await client.getTree(projectId, path);
    } catch (err) {
      // A directory that does not exist in this deployment's repo is normal — the paths above are
      // this product's layout, and a fork may not have all of them. Skip, do not fail the sync.
      if (err instanceof ForgeRequestError) continue;
      throw err;
    }
    for (const entry of tree.entries) {
      if (entry.type === "tree") {
        if (!/^(images|img|assets|screenshots)$/i.test(entry.name) && !isNonAuthoritativePath(entry.path)) {
          queue.push(entry.path);
        }
      } else if (/\.(md|markdown|txt)$/i.test(entry.name) && !isNonAuthoritativePath(entry.path)) {
        found.push(entry.path);
      }
    }
  }
  return found;
}

/**
 * Stores the safe subset of one batch of extracted records.
 *
 * Returns both counts because "we created nine entries" and "we created nine and blocked four" are
 * very different operational facts — the second says the model is drifting towards developer
 * documentation and the prompt or the module selection needs attention.
 */
async function storeEntries(params: {
  entries: ExtractedKnowledge[];
  importId: string;
  sourceLabel: string;
  moduleHint: string | null;
  humanVerified: boolean;
}): Promise<{ created: number; blocked: number }> {
  const confident = params.entries
    .filter((entry) => entry.confidence >= MIN_CONFIDENCE_TO_STORE)
    .slice(0, MAX_ENTRIES_PER_UNIT);

  const safe: ExtractedKnowledge[] = [];
  let blocked = 0;
  for (const entry of confident) {
    const verdict = checkKnowledgeEntrySafety(entry);
    if (verdict.safe) {
      safe.push(entry);
      continue;
    }
    blocked += 1;
    // Logged, not stored. The reviewer never sees it; the operator can see that the gate is
    // working and which rule fired, which is what tells them whether it is too strict.
    await logSystemEvent("WARN", "forge", "Blocked a knowledge entry that would have exposed internals", {
      sourceLabel: params.sourceLabel,
      title: entry.title,
      violations: verdict.violations.join(", "),
    });
  }
  if (safe.length === 0) return { created: 0, blocked };

  // Idempotency: re-running a sync must update the knowledge base, not duplicate it. Title plus
  // module is the natural key — the same document re-read produces the same titles.
  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { title: { in: safe.map((entry) => entry.title) }, source: "FORGE" },
    select: { title: true },
  });
  const known = new Set(existing.map((row) => row.title));
  const fresh = safe.filter((entry) => !known.has(entry.title));
  if (fresh.length === 0) return { created: 0, blocked };

  // One at a time through `createKnowledgeItem` rather than `createMany`, and the round trips buy
  // something: createMany cannot write the related `AiKnowledgeVersion` row, and this path silently
  // did not — so every entry the repository sync produced claimed `currentVersion: 1` with no
  // version behind it, which an evidence snapshot pointing at version 1 would resolve to nothing.
  // A few hundred inserts on a six-hourly job is not a cost worth trading that for.
  for (const entry of fresh) {
    await createKnowledgeItem({
      title: entry.title,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      procedure: entry.procedure,
      module: params.moduleHint ?? entry.module,
      software: "ISPDIGITAL",
      source: "FORGE",
      importId: params.importId,
      sourceLabel: params.sourceLabel,
      confidence: entry.confidence,
      aiGenerated: true,
      // GLOBAL, explicitly. This reads the PRODUCT's own repository, not a conversation — it is a
      // statement about how the software behaves, true for every group, and it carries no
      // `sourceGroupId` for the provenance rule to infer anything else from. Stated rather than
      // left to the default so the reasoning is visible at the place it applies.
      scope: "GLOBAL",
      // Auto-verification is per entry, not per batch. A tier-1 document is authoritative, but a
      // model summarising one still produces the occasional "refresh the page, contact your IT
      // support" — and auto-verifying that puts it straight in front of customers, where it does
      // more harm than the gap it fills. It still gets stored; it just has to be read by a person
      // first, which is what the admin's setting was always promising for the ones worth trusting.
      humanVerified: params.humanVerified && checkKnowledgeEntrySubstance(entry).substantive,
    });
  }

  const withheld = params.humanVerified
    ? fresh.filter((entry) => !checkKnowledgeEntrySubstance(entry).substantive)
    : [];
  if (withheld.length > 0) {
    // Visible, like the safety gate's own blocks: an operator has to be able to see the gate
    // working and judge whether it is too strict, rather than wonder why the review queue grew.
    await logSystemEvent("INFO", "forge", "Stored entries unverified: they did not pass the substance check", {
      sourceLabel: params.sourceLabel,
      count: withheld.length,
      titles: withheld.slice(0, 5).map((entry) => entry.title).join(" | "),
    });
  }

  return { created: fresh.length, blocked };
}

/** One AI round trip, parsed. Returns [] rather than throwing on an unusable response. */
async function extract(client: AiClient, prompt: ReturnType<typeof buildUserGuidePrompt>): Promise<ExtractedKnowledge[]> {
  const completion = await client.complete({
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
  });
  return parseKnowledgeRecords(completion.text ?? "");
}

/**
 * Runs one full sync. `clientOverride` is the test-only seam every other AI job in this worker
 * uses; production never passes it.
 */
export async function runForgeKnowledgeSync(clientOverride?: AiClient): Promise<ForgeSyncResult> {
  if (!isForgeConfigured()) return { ran: false, skipped: "FORGE_NOT_CONFIGURED" };

  const settings = await getForgeSettings();
  if (!settings.enabled) return { ran: false, skipped: "FORGE_DISABLED" };
  if (!settings.projectId) return { ran: false, skipped: "NO_PROJECT_SELECTED" };

  const aiSettings = await getAiSettings();
  if (!aiSettings.aiEngineEnabled) return { ran: false, skipped: "AI_ENGINE_DISABLED" };

  const ai = clientOverride ?? (await resolveAiClient("LEARNING"));
  if (!ai) return { ran: false, skipped: "AI_UNAVAILABLE" };

  const forge = new ForgeClient(loadForgeConfigFromEnv());
  const projectId = settings.projectId;

  await prisma.forgeSettings.update({
    where: { id: "global" },
    data: { lastSyncStartedAt: new Date(), lastSyncError: null },
  });

  let documentsRead = 0;
  let modulesRead = 0;
  let entriesCreated = 0;
  let entriesBlocked = 0;

  try {
    // ---- Tier 1: documentation the team wrote for customers -------------------------------
    if (settings.syncUserGuides) {
      const paths = new Set<string>(USER_GUIDE_FILES);
      for (const directory of USER_GUIDE_DIRECTORIES) {
        for (const path of await listFilesUnder(forge, projectId, directory)) paths.add(path);
      }

      for (const path of paths) {
        let file;
        try {
          file = await forge.getFile(projectId, path);
        } catch (err) {
          if (err instanceof ForgeRequestError) continue; // absent in this repo — not an error
          throw err;
        }
        if (file.kind !== "text" || !file.content?.trim()) continue;

        const label = `ISPDIGITAL manual — ${path.split("/").pop()}`;
        const chunks = chunkDocument(file.content);
        if (chunks.length === 0) continue;

        const record = await prisma.knowledgeImport.create({
          data: {
            label,
            sourceType: "FORGE_REPO",
            rawText: file.content,
            module: null,
            status: "PROCESSING",
            chunksTotal: chunks.length,
            startedAt: new Date(),
          },
        });

        let created = 0;
        let blocked = 0;
        for (const [index, chunk] of chunks.entries()) {
          const entries = await extract(
            ai,
            buildUserGuidePrompt({ documentTitle: label, moduleHint: null, chunk, chunkIndex: index, chunkCount: chunks.length }),
          );
          const stored = await storeEntries({
            entries,
            importId: record.id,
            sourceLabel: label,
            moduleHint: null,
            // The admin's recorded decision. Tier 1 only — see this file's doc comment.
            humanVerified: settings.autoVerifyUserGuides,
          });
          created += stored.created;
          blocked += stored.blocked;
          await prisma.knowledgeImport.update({
            where: { id: record.id },
            data: { chunksDone: index + 1, entriesCreated: created },
          });
        }

        await prisma.knowledgeImport.update({
          where: { id: record.id },
          data: { status: "COMPLETED", completedAt: new Date(), entriesCreated: created },
        });
        documentsRead += 1;
        entriesCreated += created;
        entriesBlocked += blocked;
      }
    }

    // ---- Tier 2: product areas with no hand-written guide ----------------------------------
    if (settings.syncModuleGuides) {
      let modules: ForgeKnowledgeModule[] = [];
      try {
        modules = await forge.listKnowledgeModules(projectId);
      } catch (err) {
        if (!(err instanceof ForgeRequestError)) throw err;
      }

      for (const module of modules) {
        const sources = await readModuleSources(forge, projectId, module);
        if (sources.length === 0) continue;

        const label = `ISPDIGITAL module — ${module.name}`;
        const record = await prisma.knowledgeImport.create({
          data: {
            label,
            sourceType: "FORGE_REPO",
            // What the model was actually shown, kept so a disappointing result can be re-run
            // against a better prompt without re-reading the repository.
            rawText: sources.map((source) => `--- ${source.path} ---\n${source.content}`).join("\n\n"),
            module: module.name,
            status: "PROCESSING",
            chunksTotal: 1,
            startedAt: new Date(),
          },
        });

        const entries = await extract(
          ai,
          buildModuleGuidePrompt({ moduleName: module.name, moduleSummary: module.summary, sources }) as ReturnType<
            typeof buildUserGuidePrompt
          >,
        );
        const stored = await storeEntries({
          entries,
          importId: record.id,
          sourceLabel: label,
          moduleHint: module.name,
          // Never auto-verified, whatever the setting says. This is the trust boundary.
          humanVerified: false,
        });

        await prisma.knowledgeImport.update({
          where: { id: record.id },
          data: { status: "COMPLETED", completedAt: new Date(), chunksDone: 1, entriesCreated: stored.created },
        });
        modulesRead += 1;
        entriesCreated += stored.created;
        entriesBlocked += stored.blocked;
      }
    }

    await prisma.forgeSettings.update({
      where: { id: "global" },
      data: { lastSyncCompletedAt: new Date(), lastSyncError: null },
    });
    await logSystemEvent("INFO", "forge", "Finished learning from the ISPDIGITAL repository", {
      documentsRead,
      modulesRead,
      entriesCreated,
      entriesBlocked,
    });

    return { ran: true, documentsRead, modulesRead, entriesCreated, entriesBlocked };
  } catch (err) {
    const message =
      err instanceof ForgeRequestError
        ? err.message
        : "Could not finish reading the ISPDIGITAL repository. Check the Forge connection and try again.";
    await prisma.forgeSettings.update({ where: { id: "global" }, data: { lastSyncError: message } });
    await logSystemEvent("ERROR", "forge", "Forge knowledge sync failed", { error: (err as Error).message });
    return { ran: true, documentsRead, modulesRead, entriesCreated, entriesBlocked, skipped: message };
  }
}

/**
 * Reads the source files behind one module, newest-listed first, up to the character budget.
 *
 * Forge's module map already names the few files that matter for each area, which is what makes
 * this affordable — the alternative is walking a repository with tens of thousands of files to
 * guess which ones implement "billing".
 */
export async function readModuleSources(
  forge: ForgeClient,
  projectId: string,
  module: ForgeKnowledgeModule,
): Promise<Array<{ path: string; content: string }>> {
  const sources: Array<{ path: string; content: string }> = [];
  let budget = MAX_SOURCE_CHARS_PER_MODULE;

  const read = async (path: string): Promise<boolean> => {
    if (budget <= 0) return false;
    let file;
    try {
      file = await forge.getFile(projectId, path);
    } catch (err) {
      // Forge's module map is maintained separately from the code, so a path can have moved or
      // been deleted. That is a stale map, not a failure of this sync.
      if (err instanceof ForgeRequestError) return false;
      throw err;
    }
    if (file.kind !== "text" || !file.content) return false;

    const content = file.content.slice(0, MAX_SOURCE_CHARS_PER_FILE);
    sources.push({ path, content: content.slice(0, budget) });
    budget -= content.length;
    return true;
  };

  for (const path of module.sourcePaths ?? []) {
    if (isNonAuthoritativePath(path)) continue;
    await read(path);
  }
  if (sources.length > 0) return sources;

  // Nothing in the map resolved. Measured against the real repository, that is 8 of 22 modules —
  // support, tariff and inventory among them, which are exactly the areas customers ask about. So
  // fall back to finding the files by name before giving up on the module entirely.
  //
  // Returning nothing is still a perfectly good outcome: the caller skips a module with no
  // sources, and it must, because a model given a module NAME and no code will cheerfully invent
  // a plausible guide for it. That was observed — "Support & Tickets" produced five confident
  // answers from zero bytes of source.
  for (const path of await findControllersForModule(forge, projectId, module)) await read(path);
  return sources;
}

/** Where this product keeps the request handlers that define user-visible behaviour. */
const CONTROLLER_DIRECTORIES = [
  "ISPDIGITAL Current/ISPDIGITAL.Web/Controllers",
  "ISPDIGITAL Legacy/web/Controllers",
];

/**
 * Finds files whose names look like they implement a module, for when Forge's map is stale.
 *
 * Matching is on the distinctive words of the module's name and slug — "MAC Reseller" looks for
 * `mac` and `reseller` — and requires a word of at least four characters so a short fragment
 * cannot match most of the directory.
 */
async function findControllersForModule(
  forge: ForgeClient,
  projectId: string,
  module: ForgeKnowledgeModule,
): Promise<string[]> {
  const words = [
    ...new Set(
      `${module.name} ${module.slug}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !["management", "and", "the", "with"].includes(word)),
    ),
  ];
  if (words.length === 0) return [];

  const matches: string[] = [];
  for (const directory of CONTROLLER_DIRECTORIES) {
    if (matches.length >= 3) break;
    let tree;
    try {
      tree = await forge.getTree(projectId, directory);
    } catch (err) {
      if (err instanceof ForgeRequestError) continue;
      throw err;
    }
    for (const entry of tree.entries) {
      if (entry.type !== "blob" || !/Controller\.cs$/i.test(entry.name)) continue;
      const name = entry.name.toLowerCase();
      if (words.some((word) => name.includes(word))) matches.push(entry.path);
      if (matches.length >= 3) break;
    }
  }
  return matches;
}
