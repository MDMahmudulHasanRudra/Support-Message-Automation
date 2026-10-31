"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  autoMapSmart,
  checkFieldValue,
  CLIENT_DUPLICATE_POLICIES,
  EXPIRY_PART_KEYS,
  freezeSamples,
  isSmartFieldKey,
  labelOf,
  sanitizeSmartMapping,
  SMART_FIELD_KEYS,
  SMART_IDENTITY_FIELDS,
  SMART_ROSTER_FIELDS,
  upgradeMapping,
  type ClientDuplicatePolicy,
  type ClientImportFieldKey,
  type FieldIssue,
  type FileAssessment,
  type MappingSuggestion,
  type SmartMapping,
  type SmartRuleKey,
  type SmartSamples,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import type { Session } from "@/server/auth";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { getMediaStorage } from "@/server/mediaStorage";
import { importOptionsFor, loadImportLookups, resolveImportExtras } from "@/server/clientImportExtras";
import {
  analyzeSmartJob,
  filterRows,
  forgetSmartAnalysis,
  parseUpload,
  projectSamples,
  ROW_FILTERS,
  SMART_IMPORT_OFF,
  smartImportEnabled,
  type RowAnalysis,
  type RowFilter,
  type SmartSummary,
} from "@/server/smartImport";
import { deleteStagedFile, readSmartCounts, type SmartCounts } from "@/server/smartImportJobs";
import { getClientModuleSettings } from "@/server/clientModule";
import { hasPermission } from "@/server/permissions";

/**
 * Smart Bulk Import actions (SMART_IMPORT.md). Every one is a public endpoint and checks for itself:
 * `clients.import` with Client Management, the CLIENT_SMART_IMPORT feature, and a job of THIS project
 * (the scoped client — another project's id is "not found"). Changes are allowed only while the job is a
 * PREVIEW, and every change bumps `revision`, so a confirmation always names what the person reviewed.
 */

export interface SmartActionResult {
  ok: boolean;
  message: string;
}

type Gate = { session: Session } | { error: string };
const NOT_FOUND = "This import no longer exists.";
const LOCKED = "This import has been confirmed, so it can no longer be changed.";

async function gate(): Promise<Gate> {
  const access = await checkPermission("clients.import", "CLIENT_CENTER");
  if ("denied" in access) return { error: access.denied };
  if (!(await smartImportEnabled())) return { error: SMART_IMPORT_OFF };
  return { session: access.session };
}

async function refresh(jobId?: string) {
  revalidatePath(await projectPath("/clients/import"));
  if (jobId) revalidatePath(await projectPath(`/clients/import/${jobId}`));
}

const DRAFT_SELECT = { id: true, status: true, engine: true, revision: true, mapping: true, headers: true, blankHeaders: true, duplicateHeaders: true } as const;

async function draft(jobId: string) {
  if (typeof jobId !== "string" || !jobId) return null;
  return prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: DRAFT_SELECT });
}

/** Bumps the revision only if nothing else changed it since this action read the job (two tabs). */
async function bump(jobId: string, revision: number, data: Prisma.ClientImportJobUpdateManyMutationInput = {}): Promise<boolean> {
  const r = await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW", revision }, data: { ...data, revision: revision + 1 } });
  forgetSmartAnalysis(jobId);
  return r.count === 1;
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export interface SmartReviewRow {
  id: string;
  rowNumber: number;
  status: RowAnalysis["status"];
  errors: string[];
  matchedClientId?: string;
  repeatsRow?: number;
  values: Partial<Record<ClientImportFieldKey, string>>;
  edited: ClientImportFieldKey[];
  issues: FieldIssue[];
  expiryBasis: string | null;
  recordedExpiry: boolean;
  /** The file's own cells for the mapped columns, so a correction can be compared with the source. */
  source: Record<string, string>;
  /** V5: the amounts this row states (recorded only), values filled from the phone / country, and unread numbers. */
  money: RowAnalysis["money"];
  derived: RowAnalysis["derived"];
  phoneNotes: RowAnalysis["phoneNotes"];
  stored: RowAnalysis["stored"];
}

export interface SmartReview {
  revision: number;
  summary: SmartSummary;
  assessment: FileAssessment;
  shownFields: ClientImportFieldKey[];
  rows: SmartReviewRow[];
  filteredCount: number;
  page: number;
  pageSize: number;
}

/** Every row of the page is an editable cell per field, so the review stops at 1,000 rows a page. */
const REVIEW_PAGE_SIZES = [25, 50, 100, 250, 500, 1000];

export async function loadSmartReview(jobId: string, query: { filter?: string; search?: string; page?: number; pageSize?: number }): Promise<SmartReview | { error: string }> {
  const g = await gate();
  if ("error" in g) return g;
  const job = await draft(jobId);
  if (!job) return { error: NOT_FOUND };
  const analysis = await analyzeSmartJob(job);
  const filter: RowFilter = (ROW_FILTERS as readonly string[]).includes(query.filter ?? "") ? (query.filter as RowFilter) : "all";
  const pageSize = REVIEW_PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 50;
  const filtered = filterRows(analysis.rows, filter, String(query.search ?? "").slice(0, 100));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(Number(query.page) || 1)), pages);
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
  const mapping = upgradeMapping(job.mapping);
  const columns = new Set<string>();
  for (const f of [...SMART_FIELD_KEYS, ...EXPIRY_PART_KEYS] as SmartRuleKey[]) {
    const rule = mapping.fields[f];
    if (rule?.mode === "source") {
      columns.add(rule.column);
      if (rule.fallback) columns.add(rule.fallback);
    }
  }
  const sources = await prisma.clientImportRow.findMany({ where: { jobId, id: { in: slice.map((r) => r.id) } }, select: { id: true, source: true } });
  const sourceById = new Map(sources.map((s) => [s.id, s.source as Record<string, string>]));
  return {
    revision: analysis.revision,
    summary: analysis.summary,
    assessment: analysis.assessment,
    shownFields: analysis.shownFields,
    filteredCount: filtered.length,
    page,
    pageSize,
    rows: slice.map((r) => {
      const src = sourceById.get(r.id) ?? {};
      return {
        id: r.id,
        rowNumber: r.rowNumber,
        status: r.status,
        errors: r.errors,
        matchedClientId: r.matchedClientId,
        repeatsRow: r.repeatsRow,
        values: Object.fromEntries(analysis.shownFields.map((f) => [f, r.output[f]])),
        edited: r.edited,
        issues: r.issues,
        expiryBasis: r.expiryBasis,
        recordedExpiry: r.recordedExpiry,
        source: Object.fromEntries([...columns].map((c) => [c, src[c] ?? ""])),
        money: r.money,
        derived: r.derived,
        phoneNotes: r.phoneNotes,
        stored: r.stored,
      };
    }),
  };
}

export interface SmartMappingContext {
  revision: number;
  headers: string[];
  mapping: SmartMapping;
  suggestions: MappingSuggestion[];
  samples: SmartSamples;
  /** The first values of each column, for the column list (not for a row preview: these are not one row). */
  columnPreview: Record<string, string[]>;
  /** How many rows have a value in each column. */
  columnFilled: Record<string, number>;
  /**
   * The first rows of the file as staged, whole, for the Visual Mapping grid: each preview row is one client,
   * so a phone is never shown beside another client's name (V5 §3).
   */
  previewRows: Array<{ rowNumber: number; cells: Record<string, string> }>;
  /** The project's default country (Settings → Client Module), for reading local numbers in the preview. */
  defaultCountry: string | null;
  /** May make the file's client codes the clients' codes (CLIENT_CODES.md §Import): Manage Client Module Settings. */
  canChooseCodes: boolean;
}

/** How many whole rows the mapping grid previews. */
const MAPPING_PREVIEW_ROWS = 8;

export async function loadSmartMappingContext(jobId: string): Promise<SmartMappingContext | { error: string }> {
  const g = await gate();
  if ("error" in g) return g;
  const job = await draft(jobId);
  if (!job) return { error: NOT_FOUND };
  const [rows, samples, settings] = await Promise.all([
    prisma.clientImportRow.findMany({ where: { jobId }, orderBy: { rowNumber: "asc" }, select: { rowNumber: true, source: true } }),
    projectSamples(),
    getClientModuleSettings(),
  ]);
  const columnPreview: Record<string, string[]> = {};
  const columnFilled: Record<string, number> = {};
  for (const h of job.headers) {
    columnPreview[h] = [];
    columnFilled[h] = 0;
  }
  for (const r of rows) {
    const src = r.source as Record<string, string>;
    for (const h of job.headers) {
      const v = src[h];
      if (!v) continue;
      columnFilled[h] = (columnFilled[h] ?? 0) + 1;
      if ((columnPreview[h]?.length ?? 0) < 4) columnPreview[h]!.push(v.slice(0, 60));
    }
  }
  const mapping = upgradeMapping(job.mapping);
  const used = new Set(Object.values(mapping.fields).flatMap((r) => (r?.mode === "source" ? [r.column] : [])));
  const suggestions = autoMapSmart(job.headers).suggestions.filter((s) => !mapping.fields[s.field] && !used.has(s.column));
  const previewRows = rows.slice(0, MAPPING_PREVIEW_ROWS).map((r) => {
    const src = r.source as Record<string, string>;
    return { rowNumber: r.rowNumber, cells: Object.fromEntries(job.headers.flatMap((h) => (src[h] ? [[h, src[h].slice(0, 200)]] : []))) };
  });
  const canChooseCodes = await hasPermission(g.session, "clients.manage_settings");
  return { revision: job.revision, headers: job.headers, mapping, suggestions, samples, columnPreview, columnFilled, previewRows, defaultCountry: settings.defaultCountry, canChooseCodes };
}

// ── Changing the draft ─────────────────────────────────────────────────────────────────────────

/** Roster fields given as one value for every row must name a real, active team or person here. */
async function rosterProblems(mapping: SmartMapping): Promise<string | null> {
  const constants = SMART_ROSTER_FIELDS.flatMap((f) => {
    const rule = mapping.fields[f];
    return rule?.mode === "constant" ? [[f, rule.value] as const] : [];
  });
  if (!constants.length) return null;
  const lookups = await loadImportLookups();
  for (const [field, value] of constants) {
    const r = resolveImportExtras(
      { country: null, currency: null, team: field === "team" ? value : null, soldBy: field === "soldBy" ? value : null, assignedTo: field === "assignedTo" ? value : null, subscription: null },
      lookups,
    );
    if (!r.ok) return `${labelOf(field)}: ${r.errors[0]}`;
  }
  return null;
}

export async function saveSmartMapping(jobId: string, revision: number, raw: unknown): Promise<SmartActionResult & { revision?: number }> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const clean = sanitizeSmartMapping(raw, job.headers);
  if (!clean.ok) return { ok: false, message: clean.error };
  const roster = await rosterProblems(clean.mapping);
  if (roster) return { ok: false, message: roster };
  if (!(await bump(jobId, revision, { mapping: clean.mapping as unknown as Prisma.InputJsonValue }))) {
    return { ok: false, message: "This import was changed in another tab. Reload to see the latest version." };
  }
  await refresh(jobId);
  return { ok: true, message: "Mapping saved.", revision: revision + 1 };
}

const MAX_EDIT_CHARS = 4000;

/** A person's correction of one field on one row. Saved even when still invalid: the review shows why. */
export async function editSmartRow(jobId: string, rowId: string, field: string, value: string): Promise<SmartActionResult & { errors?: string[] }> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!isSmartFieldKey(field)) return { ok: false, message: "That is not a client field." };
  if (typeof value !== "string" || value.length > MAX_EDIT_CHARS) return { ok: false, message: `A value can be at most ${MAX_EDIT_CHARS.toLocaleString()} characters.` };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const row = await prisma.clientImportRow.findFirst({ where: { id: rowId, jobId }, select: { edits: true } });
  if (!row) return { ok: false, message: "That row is not part of this import." };
  const edits: Record<string, string> = { ...(row.edits as Record<string, string>), [field]: value.trim() };
  let message = "Saved.";
  // Typing an exact expiry on a row that also has a duration would make two expiries disagree: the
  // typed one is what the person means, so the duration is cleared — and the reply says so.
  if (field === "expiryDate" && value.trim()) {
    const analysis = await analyzeSmartJob(job);
    const current = analysis.rows.find((r) => r.id === rowId);
    if (current?.output.duration) {
      edits.duration = "";
      edits.durationUnit = "";
      message = "Saved. The duration on this row was cleared, so the expiry you typed is the one used.";
    }
  }
  await prisma.clientImportRow.update({ where: { id: rowId }, data: { edits } });
  await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { revision: { increment: 1 } } });
  forgetSmartAnalysis(jobId);
  return { ok: true, message, errors: checkFieldValue(field, value.trim()) };
}

/** Takes back one correction, so the cell shows the mapped value again. */
export async function resetSmartCell(jobId: string, rowId: string, field: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!isSmartFieldKey(field)) return { ok: false, message: "That is not a client field." };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const row = await prisma.clientImportRow.findFirst({ where: { id: rowId, jobId }, select: { edits: true } });
  if (!row) return { ok: false, message: "That row is not part of this import." };
  const edits = { ...(row.edits as Record<string, string>) };
  if (!(field in edits)) return { ok: true, message: "Nothing to undo." };
  delete edits[field];
  await prisma.clientImportRow.update({ where: { id: rowId }, data: { edits } });
  await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { revision: { increment: 1 } } });
  forgetSmartAnalysis(jobId);
  return { ok: true, message: "Back to the mapped value." };
}

/** Forgets every correction on a row, so it reads the file (and the mapping) again. */
export async function resetSmartRow(jobId: string, rowId: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const r = await prisma.clientImportRow.updateMany({ where: { id: rowId, jobId }, data: { edits: {}, ignored: false } });
  await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { revision: { increment: 1 } } });
  forgetSmartAnalysis(jobId);
  return r.count ? { ok: true, message: "Row reset to the file's values." } : { ok: false, message: "That row is not part of this import." };
}

type Selection = { rowIds: string[] } | { filter: string; search?: string };

/** The row ids a selection names: explicit ids of this job, or every row a filter shows. */
async function selectRows(job: NonNullable<Awaited<ReturnType<typeof draft>>>, selection: Selection): Promise<string[] | { error: string }> {
  if ("rowIds" in selection) {
    if (!Array.isArray(selection.rowIds) || selection.rowIds.length === 0 || selection.rowIds.length > 5000 || selection.rowIds.some((id) => typeof id !== "string")) return { error: "Choose the rows first." };
    const found = await prisma.clientImportRow.findMany({ where: { jobId: job.id, id: { in: selection.rowIds } }, select: { id: true } });
    return found.map((r) => r.id);
  }
  if (!(ROW_FILTERS as readonly string[]).includes(selection.filter)) return { error: "Choose the rows first." };
  const analysis = await analyzeSmartJob(job);
  return filterRows(analysis.rows, selection.filter as RowFilter, String(selection.search ?? "").slice(0, 100)).map((r) => r.id);
}

/** Excludes rows from the import (or brings them back). Ignored rows are never imported or changed. */
export async function setSmartRowsIgnored(jobId: string, selection: Selection, ignored: boolean): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const ids = await selectRows(job, selection);
  if ("error" in ids) return { ok: false, message: ids.error };
  const r = await prisma.clientImportRow.updateMany({ where: { jobId, id: { in: ids } }, data: { ignored: Boolean(ignored) } });
  await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { revision: { increment: 1 } } });
  forgetSmartAnalysis(jobId);
  return { ok: true, message: `${r.count.toLocaleString()} row${r.count === 1 ? "" : "s"} ${ignored ? "left out of the import" : "brought back"}.` };
}

/**
 * Sets one field to one value on the rows a filter shows — a bounded correction, never a find-and-
 * replace. Not for identifier fields (it would make every row the same client). The person confirms
 * with the count they were shown; if the rows changed meanwhile, nothing is written.
 */
export async function bulkSetSmartField(jobId: string, selection: Selection, field: string, value: string, expectedCount: number): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!isSmartFieldKey(field)) return { ok: false, message: "That is not a client field." };
  if ((SMART_IDENTITY_FIELDS as readonly string[]).includes(field)) return { ok: false, message: `${labelOf(field)} identifies a client, so it cannot be set to one value for many rows.` };
  const text = String(value ?? "").trim();
  const problems = checkFieldValue(field, text);
  if (problems.length) return { ok: false, message: `${labelOf(field)}: ${problems[0]}` };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const ids = await selectRows(job, selection);
  if ("error" in ids) return { ok: false, message: ids.error };
  if (ids.length !== expectedCount) return { ok: false, message: "The rows changed since you chose them. Look again and confirm." };
  const rows = await prisma.clientImportRow.findMany({ where: { jobId, id: { in: ids } }, select: { id: true, edits: true } });
  await prisma.$transaction(rows.map((r) => prisma.clientImportRow.update({ where: { id: r.id }, data: { edits: { ...(r.edits as Record<string, string>), [field]: text } } })));
  await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { revision: { increment: 1 } } });
  forgetSmartAnalysis(jobId);
  return { ok: true, message: `${labelOf(field)} set on ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}.` };
}

/** Reads another sheet, or the same sheet with another header row, from the kept upload. Corrections are reset. */
export async function chooseSmartSheet(jobId: string, sheet: string, headerRow: number): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: { ...DRAFT_SELECT, stagingKey: true, fileName: true, sheetNames: true } });
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  if (!job.sheetNames.includes(sheet)) return { ok: false, message: "That sheet is not in the file." };
  const storage = getMediaStorage();
  if (!job.stagingKey || !storage) return { ok: false, message: "The uploaded file is no longer kept. Upload it again to choose another sheet." };
  let buffer: Buffer;
  try {
    const { stream } = await storage.get(job.stagingKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    buffer = Buffer.concat(chunks);
  } catch {
    return { ok: false, message: "The uploaded file is no longer kept. Upload it again to choose another sheet." };
  }
  const parsed = parseUpload(buffer, job.fileName, { sheet, headerRow: Number(headerRow) || null });
  if ("error" in parsed) return { ok: false, message: parsed.error };
  const { records } = parsed;
  // Rules whose columns still exist are kept; the rest are reported, never silently re-pointed.
  const old = upgradeMapping(job.mapping);
  const kept: SmartMapping = { version: 2, fields: {}, ...(old.options ? { options: old.options } : {}) };
  const dropped: string[] = [];
  for (const f of [...SMART_FIELD_KEYS, ...EXPIRY_PART_KEYS] as SmartRuleKey[]) {
    const rule = old.fields[f];
    if (!rule) continue;
    if (rule.mode === "source" && (!records.headers.includes(rule.column) || (rule.fallback && !records.headers.includes(rule.fallback)))) dropped.push(labelOf(f));
    else kept.fields[f] = rule;
  }
  const mapping = Object.keys(kept.fields).length ? kept : autoMapSmart(records.headers).mapping;
  const ok = await prisma.$transaction(
    async (tx) => {
      const claim = await tx.clientImportJob.updateMany({
        where: { id: jobId, status: "PREVIEW", revision: job.revision },
        data: {
          revision: job.revision + 1,
          sheetName: parsed.sheetName,
          headerRow: parsed.headerRow,
          headers: records.headers,
          blankHeaders: records.blankHeaders,
          duplicateHeaders: records.duplicateHeaders,
          totalRows: records.rows.length,
          mapping: mapping as unknown as Prisma.InputJsonValue,
        },
      });
      if (claim.count !== 1) return false;
      await tx.clientImportRow.deleteMany({ where: { jobId } });
      for (let i = 0; i < records.rows.length; i += 1000) {
        await tx.clientImportRow.createMany({ data: records.rows.slice(i, i + 1000).map((r) => ({ jobId, rowNumber: r.rowNumber, source: r.cells })) });
      }
      return true;
    },
    { timeout: 60_000 },
  );
  forgetSmartAnalysis(jobId);
  if (!ok) return { ok: false, message: "This import was changed in another tab. Reload to see the latest version." };
  await refresh(jobId);
  return {
    ok: true,
    message: `Read ${records.rows.length.toLocaleString()} rows from "${parsed.sheetName}" (headers on row ${parsed.headerRow}).${dropped.length ? ` These fields pointed at columns this sheet does not have and were cleared: ${dropped.join(", ")}.` : ""}`,
  };
}

// ── Confirming, cancelling, retrying ───────────────────────────────────────────────────────────

export async function confirmSmartImport(jobId: string, input: { revision: number; policy: string; acknowledged: string[] }): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!(CLIENT_DUPLICATE_POLICIES as readonly string[]).includes(input.policy)) return { ok: false, message: "Choose what to do with rows that match an existing client." };
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: { ...DRAFT_SELECT, stagingKey: true, fileName: true } });
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status !== "PREVIEW") return { ok: false, message: "This import has already been started or is no longer available." };
  if (job.revision !== input.revision) return { ok: false, message: "The import changed after you reviewed it (another tab, or a correction still saving). Look at the summary again and confirm." };
  const analysis = await analyzeSmartJob(job);
  if (analysis.assessment.blocks.length) return { ok: false, message: analysis.assessment.blocks[0]!.message };
  const acknowledged = Array.isArray(input.acknowledged) ? input.acknowledged.filter((a) => typeof a === "string") : [];
  const missing = analysis.assessment.warnings.filter((w) => !acknowledged.includes(w.code));
  if (missing.length) return { ok: false, message: `Tick that you have checked: ${missing[0]!.message}` };

  const options = await importOptionsFor(g.session);
  // Samples become fixed values now, so the import does not depend on the day or the roster it runs with.
  const frozen = freezeSamples(upgradeMapping(job.mapping), await projectSamples());
  if (frozen.useFileCodes && !(await hasPermission(g.session, "clients.manage_settings"))) {
    return { ok: false, message: "Using the file's codes as client codes needs the Manage Client Module Settings permission. Untick it in Match columns: new clients then get the project's codes, and the file's codes still find them." };
  }
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.clientImportJob.updateMany({
      where: { id: jobId, status: "PREVIEW", revision: input.revision },
      data: {
        status: "QUEUED",
        mapping: frozen as unknown as Prisma.InputJsonValue,
        duplicatePolicy: input.policy as ClientDuplicatePolicy,
        allowSubscriptions: options.subscriptions,
        acknowledgedWarnings: analysis.assessment.warnings.map((w) => w.code),
        confirmedRevision: input.revision,
        queuedAt: new Date(),
        validRows: analysis.summary.ready,
        invalidRows: analysis.summary.invalid,
        cancelRequestedAt: null,
        expiresAt: null,
        stagingKey: null,
      },
    });
    if (claim.count !== 1) return false;
    await tx.clientImportRow.updateMany({ where: { jobId, ignored: true }, data: { outcome: "IGNORED", message: "Left out on the review screen." } });
    await tx.clientImportRow.updateMany({ where: { jobId, ignored: false }, data: { outcome: "PENDING" } });
    return true;
  });
  forgetSmartAnalysis(jobId);
  if (!claimed) return { ok: false, message: "This import has already been started, or it changed after you reviewed it." };
  await deleteStagedFile(job.stagingKey);
  await logSystemEvent("INFO", "clients", `Smart import confirmed: ${analysis.summary.ready} ready of ${analysis.summary.total} rows`, { jobId, policy: input.policy, ...analysis.summary, acknowledged: analysis.assessment.warnings.map((w) => w.code) }, { actorUserId: g.session.userId, targetType: "ClientImportJob", targetId: jobId });
  await refresh(jobId);
  return { ok: true, message: "Import queued. It runs in the background; you can leave this page." };
}

/**
 * Cancel, by state: a QUEUED import goes back to the review (nothing was written); a PROCESSING one
 * stops before its next batch — rows already imported stay imported and are reported as such.
 */
export async function cancelSmartImport(jobId: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (job.status === "QUEUED") {
    const back = await prisma.$transaction(async (tx) => {
      const r = await tx.clientImportJob.updateMany({ where: { id: jobId, status: "QUEUED" }, data: { status: "PREVIEW", queuedAt: null, revision: { increment: 1 } } });
      if (r.count !== 1) return false;
      await tx.clientImportRow.updateMany({ where: { jobId }, data: { outcome: null, message: null } });
      return true;
    });
    forgetSmartAnalysis(jobId);
    await refresh(jobId);
    if (back) return { ok: true, message: "Stopped before it started. Nothing was imported; the review is open again." };
  }
  const r = await prisma.clientImportJob.updateMany({ where: { id: jobId, status: "PROCESSING", cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
  await refresh(jobId);
  return r.count === 1
    ? { ok: true, message: "Stopping after the current batch. Clients already imported are kept." }
    : { ok: false, message: "This import is not running." };
}

/** Throws a draft away: its rows and the kept file. No client is ever touched. */
export async function discardSmartDraft(jobId: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: { status: true, stagingKey: true } });
  if (!job) return { ok: false, message: NOT_FOUND };
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.clientImportJob.updateMany({ where: { id: jobId, status: "PREVIEW" }, data: { status: "CANCELLED", completedAt: new Date(), stagingKey: null, expiresAt: null } });
    if (r.count !== 1) return false;
    await tx.clientImportRow.deleteMany({ where: { jobId } });
    return true;
  });
  forgetSmartAnalysis(jobId);
  if (!done) return { ok: false, message: "Only a draft that has not been confirmed can be discarded." };
  await deleteStagedFile(job.stagingKey);
  await refresh(jobId);
  return { ok: true, message: "Draft discarded. Nothing was imported." };
}

/** Runs again ONLY the rows that failed to save or were never attempted. Imported rows are never replayed. */
export async function retrySmartImport(jobId: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: { status: true } });
  if (!job) return { ok: false, message: NOT_FOUND };
  if (!["PARTIAL", "FAILED", "CANCELLED"].includes(job.status)) return { ok: false, message: "Only a finished import with rows left over can be retried." };
  const result = await prisma.$transaction(async (tx) => {
    await tx.clientImportRow.updateMany({ where: { jobId, outcome: "FAILED" }, data: { outcome: "PENDING", message: null, processedAt: null } });
    const pending = await tx.clientImportRow.count({ where: { jobId, outcome: "PENDING" } });
    if (pending === 0) return 0;
    const r = await tx.clientImportJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: "QUEUED", queuedAt: new Date(), completedAt: null, cancelRequestedAt: null, expiresAt: null } });
    if (r.count !== 1) throw new Error("changed");
    return pending;
  }).catch(() => -1);
  await refresh(jobId);
  if (result === -1) return { ok: false, message: "This import changed meanwhile. Reload and try again." };
  if (result === 0) return { ok: false, message: "No rows are left to retry. Rows that were invalid need correcting in a new import (download the problem rows)." };
  return { ok: true, message: `${result.toLocaleString()} row${result === 1 ? "" : "s"} queued again.` };
}

export interface SmartStatus {
  status: string;
  counts: SmartCounts;
  cancelRequested: boolean;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Server time of this reading — the page shows when it last heard. */
  readAt: string;
}

/** Polled by the progress view. Refuses as "nothing to show", never a redirect. */
export async function readSmartImportStatus(jobId: string): Promise<SmartStatus | null> {
  const g = await gate();
  if ("error" in g) return null;
  const job = await prisma.clientImportJob.findFirst({ where: { id: jobId, engine: "SMART" }, select: { status: true, cancelRequestedAt: true, queuedAt: true, startedAt: true, completedAt: true } });
  if (!job) return null;
  return {
    status: job.status,
    counts: await readSmartCounts(jobId),
    cancelRequested: Boolean(job.cancelRequestedAt),
    queuedAt: job.queuedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    readAt: new Date().toISOString(),
  };
}

// ── Presets ────────────────────────────────────────────────────────────────────────────────────

export interface SmartPreset {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  fields: number;
}

export async function listSmartPresets(): Promise<SmartPreset[]> {
  const g = await gate();
  if ("error" in g) return [];
  const userId = g.session.userId;
  const rows = await prisma.clientImportPreset.findMany({ where: { OR: [{ shared: true }, { createdById: userId }] }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true, shared: true, createdById: true, mapping: true } });
  return rows.map((r) => ({ id: r.id, name: r.name, shared: r.shared, mine: r.createdById === userId, fields: Object.keys(upgradeMapping(r.mapping).fields).length }));
}

/** Saves the draft's current mapping under a name. Field rules and column names only — never a client's data. */
export async function saveSmartPreset(jobId: string, name: string, shared: boolean): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 60) return { ok: false, message: "Give the preset a name of up to 60 characters." };
  const job = await draft(jobId);
  if (!job) return { ok: false, message: NOT_FOUND };
  // Sample rules stay "sample" in a preset, so using it later takes that day's samples.
  const mapping = upgradeMapping(job.mapping);
  const existing = await prisma.clientImportPreset.findFirst({ where: { name: clean }, select: { id: true, createdById: true } });
  if (existing && existing.createdById !== g.session.userId) return { ok: false, message: "Another person already has a preset with that name. Choose another name." };
  if (existing) await prisma.clientImportPreset.update({ where: { id: existing.id }, data: { mapping: mapping as unknown as Prisma.InputJsonValue, shared: Boolean(shared), version: { increment: 1 } } });
  else await prisma.clientImportPreset.create({ data: { name: clean, shared: Boolean(shared), mapping: mapping as unknown as Prisma.InputJsonValue, createdById: g.session.userId } });
  return { ok: true, message: existing ? `Preset "${clean}" updated.` : `Preset "${clean}" saved.` };
}

export async function deleteSmartPreset(presetId: string): Promise<SmartActionResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const r = await prisma.clientImportPreset.deleteMany({ where: { id: presetId, createdById: g.session.userId } });
  return r.count ? { ok: true, message: "Preset deleted." } : { ok: false, message: "Only the person who saved a preset can delete it." };
}

/**
 * Applies a preset to this draft. A rule whose column this file does not have is left OUT and named —
 * never pointed at a column with a similar name.
 */
export async function applySmartPreset(jobId: string, revision: number, presetId: string): Promise<SmartActionResult & { revision?: number }> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const [job, preset] = await Promise.all([
    draft(jobId),
    prisma.clientImportPreset.findFirst({ where: { id: presetId, OR: [{ shared: true }, { createdById: g.session.userId }] }, select: { name: true, mapping: true } }),
  ]);
  if (!job) return { ok: false, message: NOT_FOUND };
  if (!preset) return { ok: false, message: "That preset no longer exists." };
  if (job.status !== "PREVIEW") return { ok: false, message: LOCKED };
  const wanted = upgradeMapping(preset.mapping);
  const fields: SmartMapping["fields"] = {};
  const missing: string[] = [];
  for (const f of [...SMART_FIELD_KEYS, ...EXPIRY_PART_KEYS] as SmartRuleKey[]) {
    const rule = wanted.fields[f];
    if (!rule) continue;
    if (rule.mode === "source" && !job.headers.includes(rule.column)) missing.push(`${labelOf(f)} ("${rule.column}")`);
    else if (rule.mode === "source" && rule.fallback && !job.headers.includes(rule.fallback)) fields[f] = { mode: "source", column: rule.column };
    else fields[f] = rule;
  }
  const clean = sanitizeSmartMapping({ fields, options: wanted.options }, job.headers);
  if (!clean.ok) return { ok: false, message: `The preset "${preset.name}" no longer fits: ${clean.error}` };
  if (!(await bump(jobId, revision, { mapping: clean.mapping as unknown as Prisma.InputJsonValue }))) {
    return { ok: false, message: "This import was changed in another tab. Reload to see the latest version." };
  }
  await refresh(jobId);
  return {
    ok: true,
    revision: revision + 1,
    message: missing.length ? `Applied "${preset.name}". Not applied — this file has no such column: ${missing.join(", ")}.` : `Applied "${preset.name}".`,
  };
}
