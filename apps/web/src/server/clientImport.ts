import type { Prisma } from "@prisma/client";
import {
  buildImportRows,
  findInFileDuplicates,
  matchKeyOf,
  normalizeTags,
  type ClientDuplicatePolicy,
  type ClientImportMapping,
  type ImportedClientRow,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { channelFields, loadExistingMatches, nextClientCode, recordClientActivity } from "@/server/clientRecords";

/**
 * What an import will do, and doing it (CLIENT_CENTER.md §Import). Not a "use server" file — the
 * actions in server/actions/clientImport.ts check the permission, then call these.
 *
 * Runs inside the request, in batches, up to MAX_CLIENT_IMPORT_ROWS. That is a deliberate limit of
 * this phase: a durable background import (worker loop, resumable) is an extension point for a later
 * phase, not something to fake. An import interrupted by a restart stays PROCESSING and is closed by
 * hand ("Mark as failed"); re-uploading with the Skip or Update policy then finishes it safely,
 * because rows already imported are recognised by their phone, email or code.
 */

export type RawImportRow = Record<string, string>;
const ERROR_CAP = 200;

export interface ImportRowOutcome {
  rowNumber: number;
  name: string;
  decision: "CREATE" | "MATCH" | "REPEAT_IN_FILE";
  /** The existing client a MATCH row names. */
  matchedClientId?: string;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalid: Array<{ rowNumber: number; errors: string[] }>;
  invalidCount: number;
  willCreate: number;
  matchExisting: number;
  repeatsInFile: number;
  sample: ImportRowOutcome[];
  missingRequired: string[];
}

/** The existing client a row matches, by any of its identifiers or its typed code. */
function matchOf(row: ImportedClientRow, byKey: Map<string, string>, byCode: Map<string, string>): string | undefined {
  for (const key of row.matchKeys) {
    const id = byKey.get(key);
    if (id) return id;
  }
  return row.fields.code ? byCode.get(row.fields.code.toLowerCase()) : undefined;
}

export async function computeImportPreview(rows: readonly RawImportRow[], mapping: ClientImportMapping): Promise<ImportPreview> {
  const built = buildImportRows(rows, mapping);
  const repeats = findInFileDuplicates(built.valid);
  const { byKey, byCode } = await loadExistingMatches(
    built.valid.flatMap((r) => r.matchKeys),
    built.valid.flatMap((r) => (r.fields.code ? [r.fields.code] : [])),
  );
  let willCreate = 0;
  let matchExisting = 0;
  const sample: ImportRowOutcome[] = [];
  for (const row of built.valid) {
    let outcome: ImportRowOutcome;
    if (repeats.has(row.rowNumber)) outcome = { rowNumber: row.rowNumber, name: row.fields.name, decision: "REPEAT_IN_FILE" };
    else {
      const matched = matchOf(row, byKey, byCode);
      outcome = matched ? { rowNumber: row.rowNumber, name: row.fields.name, decision: "MATCH", matchedClientId: matched } : { rowNumber: row.rowNumber, name: row.fields.name, decision: "CREATE" };
      if (matched) matchExisting += 1;
      else willCreate += 1;
    }
    if (sample.length < 15) sample.push(outcome);
  }
  return {
    totalRows: rows.length,
    validRows: built.valid.length,
    invalid: built.invalid.slice(0, 50),
    invalidCount: built.invalid.length,
    willCreate,
    matchExisting,
    repeatsInFile: repeats.size,
    sample,
    missingRequired: mapping.name ? [] : ["Name"],
  };
}

export interface ImportRunResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ rowNumber: number; errors: string[] }>;
}

async function createRow(row: ImportedClientRow, fileName: string, actorUserId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const code = row.fields.code ?? (await nextClientCode(tx));
    const created = await tx.client.create({
      data: {
        code,
        name: row.fields.name,
        companyName: row.fields.companyName,
        status: row.fields.status,
        category: row.fields.category,
        preferredLanguage: row.fields.preferredLanguage,
        address: row.fields.address,
        tags: row.fields.tags,
        source: "IMPORT",
        sourceDetail: fileName.slice(0, 200),
        createdById: actorUserId,
        channels: { create: row.channels.map((c) => channelFields(c, "import")) },
      },
      select: { id: true },
    });
    await recordClientActivity(tx, created.id, actorUserId, { type: "IMPORTED", summary: `Imported from ${fileName.slice(0, 80)} (row ${row.rowNumber})` });
  });
}

/** Applies the file's non-empty values to a client that already exists. Never un-archives, never resets a status the file did not give. */
async function updateRow(clientId: string, row: ImportedClientRow, fileName: string, actorUserId: string | null): Promise<"UPDATED" | "ARCHIVED"> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.client.findFirst({ where: { id: clientId }, include: { channels: { select: { kind: true, normalizedValue: true } } } });
    if (!current || current.status === "ARCHIVED") return "ARCHIVED" as const;
    const data: Prisma.ClientUpdateInput = {};
    const changed: string[] = [];
    const set = <K extends "name" | "companyName" | "category" | "preferredLanguage" | "address">(key: K, value: string | null) => {
      if (value && value !== current[key]) {
        (data as Record<string, unknown>)[key] = value;
        changed.push(key);
      }
    };
    set("name", row.fields.name);
    set("companyName", row.fields.companyName);
    set("category", row.fields.category);
    set("preferredLanguage", row.fields.preferredLanguage);
    set("address", row.fields.address);
    if (row.statusGiven && row.fields.status !== current.status) {
      data.status = row.fields.status;
      changed.push("status");
    }
    const tags = normalizeTags([...current.tags, ...row.fields.tags]);
    if (tags.join("|") !== current.tags.join("|")) {
      data.tags = tags;
      changed.push("tags");
    }
    const have = new Set(current.channels.map((c) => matchKeyOf(c.kind, c.normalizedValue)));
    const newChannels = row.channels.filter((c) => !have.has(c.matchKey));
    if (newChannels.length) {
      // A new primary must not displace an existing one of the same kind.
      const primaryKinds = new Set((await tx.clientChannel.findMany({ where: { clientId, isPrimary: true }, select: { kind: true } })).map((c) => c.kind));
      await tx.clientChannel.createMany({ data: newChannels.map((c) => ({ clientId, ...channelFields({ ...c, isPrimary: c.isPrimary && !primaryKinds.has(c.kind) }, "import") })), skipDuplicates: true });
      changed.push("channels");
    }
    if (Object.keys(data).length) await tx.client.update({ where: { id: clientId }, data });
    if (changed.length) await recordClientActivity(tx, clientId, actorUserId, { type: "IMPORT_UPDATED", summary: `Updated from ${fileName.slice(0, 80)}: ${changed.join(", ")}` });
    return "UPDATED" as const;
  });
}

/**
 * Runs a PREVIEW job that has been claimed. Every row is its own unit: a failing row is reported and
 * the rest carry on. `onProgress` is called every batch so the history page shows movement.
 */
export async function processImportRows(
  rows: readonly RawImportRow[],
  mapping: ClientImportMapping,
  policy: ClientDuplicatePolicy,
  fileName: string,
  actorUserId: string | null,
  onProgress: (partial: ImportRunResult) => Promise<void>,
): Promise<ImportRunResult> {
  const built = buildImportRows(rows, mapping);
  const repeats = findInFileDuplicates(built.valid);
  const { byKey, byCode } = await loadExistingMatches(
    built.valid.flatMap((r) => r.matchKeys),
    built.valid.flatMap((r) => (r.fields.code ? [r.fields.code] : [])),
  );
  const result: ImportRunResult = { imported: 0, updated: 0, skipped: 0, failed: built.invalid.length, errors: built.invalid.slice(0, ERROR_CAP).map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })) };
  const note = (rowNumber: number, message: string) => {
    if (result.errors.length < ERROR_CAP) result.errors.push({ rowNumber, errors: [message] });
  };

  let done = 0;
  for (const row of built.valid) {
    try {
      const firstRow = repeats.get(row.rowNumber);
      if (firstRow !== undefined) {
        result.skipped += 1;
        note(row.rowNumber, `Skipped: repeats row ${firstRow} of this file.`);
        continue;
      }
      const matched = matchOf(row, byKey, byCode);
      if (matched && policy === "SKIP") {
        result.skipped += 1;
        note(row.rowNumber, "Skipped: matches a client you already have.");
      } else if (matched && policy === "UPDATE") {
        const outcome = await updateRow(matched, row, fileName, actorUserId);
        if (outcome === "UPDATED") result.updated += 1;
        else {
          result.skipped += 1;
          note(row.rowNumber, "Skipped: the matching client is archived. Restore it first.");
        }
      } else {
        // No match, or the administrator chose to create the client anyway.
        await createRow(row, fileName, actorUserId);
        result.imported += 1;
      }
    } catch (err) {
      result.failed += 1;
      note(row.rowNumber, isUniqueViolation(err) ? "That client code is already used by another client." : "The row could not be saved.");
    }
    done += 1;
    if (done % 100 === 0) await onProgress(result);
  }
  return result;
}
