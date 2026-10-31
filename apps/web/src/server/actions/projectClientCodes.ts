"use server";

import { revalidatePath } from "next/cache";
import { changeClientCodeSeries, ClientCodeSeriesError } from "@support-automation/db";
import type { CodePlanOptions, CodePlanRow } from "@support-automation/shared";
import { globalPrisma, platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import { applyCodeConversion, previewCodeConversion } from "@/server/clientCodes";
import { clientCodeConversionEnabled } from "@/server/clientCodeSettings";

/**
 * Main Admin → Project → Client codes (CLIENT_CODES.md). Every action needs `projects.manage` and a project the
 * admin's own customer holds (`platformPrisma` is customer-scoped, so another customer's project is "not found").
 * Saving a series never renames a client; converting existing codes is a separate, reviewed, logged step.
 */

const DENIED = "Changing client codes needs the “Manage Projects and Project Access” permission.";

async function requireProject(projectId: string): Promise<{ session: Session; project: { id: string; name: string } } | { error: string }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "projects.manage"))) return { error: DENIED };
  const project = await platformPrisma.project.findFirst({ where: { id: projectId }, select: { id: true, name: true } });
  return project ? { session, project } : { error: "That project no longer exists." };
}

export interface CodeSeriesFormState {
  error?: string;
  field?: "prefix" | "minWidth" | "nextSerial" | null;
  success?: string;
}

export async function saveClientCodeSeries(projectId: string, _prev: CodeSeriesFormState, formData: FormData): Promise<CodeSeriesFormState> {
  const access = await requireProject(projectId);
  if ("error" in access) return { error: access.error };
  const width = Number(formData.get("minWidth") ?? "");
  try {
    const { changed } = await globalPrisma.$transaction((tx) =>
      changeClientCodeSeries(tx, {
        projectId,
        prefix: formData.has("prefix") ? String(formData.get("prefix")) : null,
        minWidth: Number.isFinite(width) && width > 0 ? width : null,
        nextSerial: String(formData.get("nextSerial") ?? "").trim() || null,
        actorUserId: access.session.userId,
      }),
    );
    if (!changed.length) return { success: "Nothing changed." };
    await logSystemEvent("INFO", "projects", `Client codes of "${access.project.name}" changed: ${changed.join("; ")}`, { projectId, changed, changedBy: access.session.username }, { actorUserId: access.session.userId, targetType: "Project", targetId: projectId });
    revalidatePath(`/admin/projects/${projectId}`, "layout");
    return { success: `Saved: ${changed.join("; ")}. Codes already given to clients are unchanged.` };
  } catch (err) {
    if (err instanceof ClientCodeSeriesError) return { error: err.message, field: err.field };
    throw err;
  }
}

export interface ConversionPreviewResult {
  error?: string;
  hash?: string;
  counts?: { clients: number; legacyPattern: number; custom: number; inSeries: number; archived: number; changes: number; kept: number };
  nextSerialAfter?: string;
  /** The changes first, then what is kept; at most 500 rows on screen — the export has all of them. */
  rows?: CodePlanRow[];
  applyEnabled?: boolean;
}

function readOptions(options: Partial<CodePlanOptions>): CodePlanOptions {
  return { convertLegacyPattern: options.convertLegacyPattern !== false, convertCustom: options.convertCustom === true };
}

/** The dry run. Reads only: nothing is written, whatever it shows. */
export async function previewClientCodeConversion(projectId: string, options: Partial<CodePlanOptions>): Promise<ConversionPreviewResult> {
  const access = await requireProject(projectId);
  if ("error" in access) return { error: access.error };
  const preview = await previewCodeConversion(projectId, readOptions(options));
  if (!preview) return { error: "This project has no client code series yet." };
  const ordered = [...preview.plan.rows.filter((r) => r.to), ...preview.plan.rows.filter((r) => !r.to)];
  return {
    hash: preview.plan.hash,
    counts: { ...preview.counts, changes: preview.plan.changes, kept: preview.plan.kept },
    nextSerialAfter: preview.plan.nextSerialAfter,
    rows: ordered.slice(0, 500),
    applyEnabled: clientCodeConversionEnabled(),
  };
}

/**
 * Applies the reviewed plan. Needs the conversion switched on for this installation (CLIENT_CODE_CONVERSION_ENABLED),
 * the project's name typed, and the preview's hash: if anything changed since, nothing is applied.
 */
export async function applyClientCodeConversion(
  projectId: string,
  input: { options: Partial<CodePlanOptions>; hash: string; confirmName: string },
): Promise<{ ok: boolean; message: string }> {
  const access = await requireProject(projectId);
  if ("error" in access) return { ok: false, message: access.error };
  if (!clientCodeConversionEnabled()) {
    return { ok: false, message: "Converting existing codes is switched off for this installation (CLIENT_CODE_CONVERSION_ENABLED). The preview and export still work." };
  }
  if (input.confirmName.trim() !== access.project.name) return { ok: false, message: `Type the project's name, ${access.project.name}, to confirm.` };
  const options = readOptions(input.options);
  const result = await applyCodeConversion(projectId, { options, expectedHash: input.hash, actorUserId: access.session.userId });
  if (!result.ok) return { ok: false, message: result.error };
  await logSystemEvent(
    "WARN",
    "projects",
    `Client codes of "${access.project.name}" converted: ${result.changed} client(s)`,
    { projectId, batchId: result.batchId, changed: result.changed, options, changedBy: access.session.username },
    { actorUserId: access.session.userId, targetType: "Project", targetId: projectId, correlationId: result.batchId },
  );
  revalidatePath(`/admin/projects/${projectId}`, "layout");
  revalidatePath(`/p`, "layout");
  return {
    ok: true,
    message: `${result.changed} client code(s) converted (batch ${result.batchId}). Every old code still finds its client.`,
  };
}

/**
 * The whole dry run as CSV (every row, not the 500 on screen), for review and as the before → after record kept with
 * a backup. Codes are written as text; a spreadsheet opening a CSV may still read "0001" as 1 — import it as text.
 */
export async function exportClientCodeConversion(projectId: string, options: Partial<CodePlanOptions>): Promise<{ error?: string; csv?: string; fileName?: string }> {
  const access = await requireProject(projectId);
  if ("error" in access) return { error: access.error };
  const preview = await previewCodeConversion(projectId, readOptions(options));
  if (!preview) return { error: "This project has no client code series yet." };
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    ["Client id", "Current code", "New code", "Kind of code", "Archived"].join(","),
    ...preview.plan.rows.map((r) => [r.clientId, cell(r.from), cell(r.to ?? "(kept)"), r.category, r.archived ? "yes" : "no"].join(",")),
  ];
  const day = new Date().toISOString().slice(0, 10);
  return { csv: `﻿${lines.join("\r\n")}\r\n`, fileName: `client-codes-${access.project.name.replace(/[^\w-]+/g, "-")}-${day}-preview.csv` };
}
