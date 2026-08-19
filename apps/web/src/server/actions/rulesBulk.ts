"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import type { Prisma, RuleStatus } from "@prisma/client";
import {
  MAX_EXCEL_FILE_SIZE_BYTES,
  parseRuleImportRows,
  type RuleImportRow,
  type RuleImportRowResult,
} from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";
import { validateRuleBusinessRules } from "@/server/ruleValidation";

/**
 * Bulk management for the existing Automation Rules module. Every function here is an additional
 * management layer over the same AutomationRule records the rule engine already reads — nothing
 * about rule evaluation, precedence, or the individual create/edit/activate/delete actions in
 * rules.ts changes. Authorization is identical to every existing single-rule action: this app has
 * no role/permission system (any authenticated session has full access today), so "equivalent or
 * stronger" authorization for bulk means the same, only check that exists — requireSession().
 */

// ---------------------------------------------------------------------------
// Bulk activate / disable — mirrors apps/web/src/server/actions/groups.ts's
// bulkSetMonitoring() exactly: dedupe -> look up existing -> split into
// notFound/alreadyInTargetState/toChange -> one updateMany on the subset that
// actually needs it -> structured result.
// ---------------------------------------------------------------------------

export interface BulkRuleStatusResult {
  requested: number;
  updated: number;
  alreadyInTargetState: number;
  notFound: number;
  error?: string;
}

export async function bulkSetRuleStatus(ruleIds: string[], status: "ACTIVE" | "DISABLED"): Promise<BulkRuleStatusResult> {
  await requireSession();

  const dedupedIds = [...new Set(ruleIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, updated: 0, alreadyInTargetState: 0, notFound: 0, error: "No rules selected." };
  }

  const existing = await prisma.automationRule.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true, status: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));
  const notFound = dedupedIds.filter((id) => !existingIds.has(id)).length;
  const alreadyInTargetState = existing.filter((r) => r.status === status).length;
  const idsToChange = existing.filter((r) => r.status !== status).map((r) => r.id);

  let updated = 0;
  if (idsToChange.length > 0) {
    const result = await prisma.automationRule.updateMany({
      where: { id: { in: idsToChange } },
      data: { status },
    });
    updated = result.count;
  }

  await logSystemEvent("INFO", "automation-rules", `Bulk rule ${status === "ACTIVE" ? "activate" : "disable"}: ${updated} updated`, {
    requested: dedupedIds.length,
    updated,
    alreadyInTargetState,
    notFound,
  });
  revalidatePath("/rules");
  return { requested: dedupedIds.length, updated, alreadyInTargetState, notFound };
}

// ---------------------------------------------------------------------------
// Bulk delete — every relation off AutomationRule (AutomationExecution,
// OutboundMessage, Notification, RuleProposal.createdRuleId) is onDelete:
// SetNull, so deleting a rule is always safe and matches the existing
// single-rule deleteRule()'s own hard-delete behavior; there is no "cannot
// safely delete" case to special-case.
// ---------------------------------------------------------------------------

export interface BulkDeleteRulesResult {
  requested: number;
  deleted: number;
  notFound: number;
  error?: string;
}

export async function bulkDeleteRules(ruleIds: string[]): Promise<BulkDeleteRulesResult> {
  await requireSession();

  const dedupedIds = [...new Set(ruleIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (dedupedIds.length === 0) {
    return { requested: 0, deleted: 0, notFound: 0, error: "No rules selected." };
  }

  const existing = await prisma.automationRule.findMany({
    where: { id: { in: dedupedIds } },
    select: { id: true },
  });
  const existingIds = existing.map((r) => r.id);
  const notFound = dedupedIds.length - existingIds.length;

  let deleted = 0;
  if (existingIds.length > 0) {
    // A single deleteMany is already atomic as one statement — no explicit $transaction needed,
    // same reasoning bulkSetMonitoring/bulkSetRuleStatus rely on for their own updateMany.
    const result = await prisma.automationRule.deleteMany({ where: { id: { in: existingIds } } });
    deleted = result.count;
  }

  await logSystemEvent("INFO", "automation-rules", `Bulk rule delete: ${deleted} deleted`, {
    requested: dedupedIds.length,
    deleted,
    notFound,
  });
  revalidatePath("/rules");
  return { requested: dedupedIds.length, deleted, notFound };
}

// ---------------------------------------------------------------------------
// Excel import — preview then confirm. Parsing/structural validation is pure
// (packages/shared's automationRuleImport.ts); this file adds the two checks
// that genuinely need apps/web (regex safety via validateRuleBusinessRules,
// and duplicate-against-existing-database-rows).
// ---------------------------------------------------------------------------

export interface RuleImportPreviewRow {
  rowNumber: number;
  name: string;
  type: string;
  matchType: string;
  matchValue: string | null;
  actionsSummary: string;
  outcome: RuleImportRowResult["outcome"];
  reason: string;
  /** Only present for rows that are still eligible to be created — carried back to
   * confirmRuleImport() as plain structured data, not a re-upload of the file. */
  row: RuleImportRow | null;
}

export interface RuleImportPreviewResult {
  fileErrors: string[];
  rows: RuleImportPreviewRow[];
}

function summarizeActions(row: RuleImportRow): string {
  return row.actions.map((a) => a.type).join(", ") || "—";
}

/** Runs the two apps/web-only checks on top of packages/shared's structural parse: regex safety
 * (the one check that can't live in packages/shared — see automationRuleImport.ts's own doc
 * comment) and duplicate-against-existing-rows. Shared between preview and confirm so both stages
 * apply identical rules — confirm never trusts the client-held preview outcome as final. */
async function revalidateRow(parsed: RuleImportRowResult, existingNames: Set<string>): Promise<RuleImportRowResult> {
  if (parsed.outcome !== "VALID" || !parsed.row) return parsed;

  const normalizedName = parsed.row.name.trim().toLowerCase();
  if (existingNames.has(normalizedName)) {
    return {
      ...parsed,
      outcome: "DUPLICATE_EXISTING",
      reason: `A rule named "${parsed.row.name}" already exists.`,
    };
  }

  const businessError = validateRuleBusinessRules({
    name: parsed.row.name,
    matchType: parsed.row.matchType,
    matchValue: parsed.row.matchValue,
    actions: parsed.row.actions,
    timeWindowEnabled: Boolean(parsed.row.conditions.timeWindow),
    timeWindowStartHour: parsed.row.conditions.timeWindow?.startHour,
    timeWindowEndHour: parsed.row.conditions.timeWindow?.endHour,
  });
  if (businessError) {
    return { ...parsed, outcome: "INVALID", reason: businessError };
  }

  return parsed;
}

export async function previewRuleImport(formData: FormData): Promise<RuleImportPreviewResult> {
  await requireSession();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { fileErrors: ["No file was uploaded."], rows: [] };
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return { fileErrors: ["Only .xlsx files are supported."], rows: [] };
  }
  if (file.size > MAX_EXCEL_FILE_SIZE_BYTES) {
    return {
      fileErrors: [`File is ${Math.ceil(file.size / (1024 * 1024))}MB, exceeding the ${MAX_EXCEL_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`],
      rows: [],
    };
  }

  let rawRows: Array<Record<string, unknown>>;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { fileErrors: ["The file has no sheets."], rows: [] };
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, { defval: "" });
  } catch {
    return { fileErrors: ["The file could not be read — make sure it is a valid .xlsx file."], rows: [] };
  }

  const { results, fileErrors } = parseRuleImportRows(rawRows);
  if (fileErrors.length > 0) return { fileErrors, rows: [] };

  const existingRules = await prisma.automationRule.findMany({ select: { name: true } });
  const existingNames = new Set(existingRules.map((r) => r.name.trim().toLowerCase()));

  const revalidated = await Promise.all(results.map((r) => revalidateRow(r, existingNames)));

  const rows: RuleImportPreviewRow[] = revalidated.map((r) => ({
    rowNumber: r.rowNumber,
    name: r.row?.name ?? "",
    type: r.row?.type ?? "",
    matchType: r.row?.matchType ?? "",
    matchValue: r.row?.matchValue ?? null,
    actionsSummary: r.row ? summarizeActions(r.row) : "—",
    outcome: r.outcome,
    reason: r.reason,
    row: r.outcome === "VALID" ? r.row : null,
  }));

  return { fileErrors: [], rows };
}

export interface RuleImportResultDetail {
  rowNumber: number;
  name: string;
  outcome: "CREATED" | "SKIPPED" | "FAILED";
  reason: string;
}

export interface RuleImportResult {
  created: number;
  skipped: number;
  failed: number;
  details: RuleImportResultDetail[];
  error?: string;
}

/**
 * Receives the client-held, already-previewed rows — never a re-upload — but re-validates every
 * one of them from scratch server-side before writing anything, same "never trust the client
 * preview as-is" principle apps/web/src/server/actions/groupBroadcast.ts's own confirm step
 * already follows. Partial success: valid rows are created, invalid/duplicate rows are skipped
 * with a recorded reason — matches this repo's own established Excel-import precedent
 * (createGroupBroadcastJob also lets valid rows through around bad ones) rather than an atomic
 * all-or-nothing import. Every created row is forced to status DRAFT regardless of anything else —
 * matches this codebase's own established safety convention (Rule Proposals/AI-approved rules are
 * always DRAFT; a human separately activates via Bulk Activate or the individual Enable action).
 */
export async function confirmRuleImport(rows: Array<{ rowNumber: number; row: RuleImportRow }>): Promise<RuleImportResult> {
  await requireSession();

  if (rows.length === 0) {
    return { created: 0, skipped: 0, failed: 0, details: [], error: "No valid rows to import." };
  }

  const existingRules = await prisma.automationRule.findMany({ select: { name: true } });
  const existingNames = new Set(existingRules.map((r) => r.name.trim().toLowerCase()));
  const seenInBatch = new Set<string>();

  const details: RuleImportResultDetail[] = [];
  const toCreate: Prisma.AutomationRuleCreateManyInput[] = [];

  for (const { rowNumber, row } of rows) {
    const normalizedName = row.name.trim().toLowerCase();
    if (existingNames.has(normalizedName)) {
      details.push({ rowNumber, name: row.name, outcome: "SKIPPED", reason: `A rule named "${row.name}" already exists.` });
      continue;
    }
    if (seenInBatch.has(normalizedName)) {
      details.push({ rowNumber, name: row.name, outcome: "SKIPPED", reason: `"${row.name}" appears more than once in this import.` });
      continue;
    }
    const businessError = validateRuleBusinessRules({
      name: row.name,
      matchType: row.matchType,
      matchValue: row.matchValue,
      actions: row.actions,
      timeWindowEnabled: Boolean(row.conditions.timeWindow),
      timeWindowStartHour: row.conditions.timeWindow?.startHour,
      timeWindowEndHour: row.conditions.timeWindow?.endHour,
    });
    if (businessError) {
      details.push({ rowNumber, name: row.name, outcome: "SKIPPED", reason: businessError });
      continue;
    }

    seenInBatch.add(normalizedName);
    toCreate.push({
      name: row.name,
      description: row.description,
      type: row.type,
      matchType: row.matchType,
      matchValue: row.matchValue,
      keywords: row.keywords,
      conditions: row.conditions as unknown as Prisma.InputJsonValue,
      actions: row.actions as unknown as Prisma.InputJsonValue,
      priority: row.priority,
      status: "DRAFT" as RuleStatus,
      cooldownSeconds: row.cooldownSeconds,
      replyMessage: row.replyMessage,
      replyDelayMinMs: row.replyDelayMinMs,
      replyDelayMaxMs: row.replyDelayMaxMs,
    });
    details.push({ rowNumber, name: row.name, outcome: "CREATED", reason: "Created as DRAFT." });
  }

  let created = 0;
  if (toCreate.length > 0) {
    try {
      const result = await prisma.automationRule.createMany({ data: toCreate });
      created = result.count;
    } catch (err) {
      // A batch-level failure (rare — every row here already passed validation) must never expose
      // a raw Prisma error to the user; log it, then report every row that was about to be
      // created as FAILED rather than silently claiming success.
      await logSystemEvent("ERROR", "automation-rules", "Bulk rule import batch insert failed", {
        error: (err as Error).message,
        attemptedCount: toCreate.length,
      });
      for (const detail of details) {
        if (detail.outcome === "CREATED") {
          detail.outcome = "FAILED";
          detail.reason = "Could not be created due to a server error. See System Logs for details.";
        }
      }
      created = 0;
    }
  }

  const skipped = details.filter((d) => d.outcome === "SKIPPED").length;
  const failed = details.filter((d) => d.outcome === "FAILED").length;

  await logSystemEvent("INFO", "automation-rules", `Bulk rule import: ${created} created, ${skipped} skipped, ${failed} failed`, {
    created,
    skipped,
    failed,
  });
  revalidatePath("/rules");
  return { created, skipped, failed, details };
}
