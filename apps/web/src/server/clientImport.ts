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
import { ClientCodeSeriesError, clientCodeTaken } from "@support-automation/db";
import { prisma } from "@/server/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { activeProjectId } from "@/server/projectContext";
import { recordClientCodeAlias, typedClientCodeRefusal } from "@/server/clientCodes";
import { channelFields, loadExistingMatches, nextClientCode, recordClientActivity } from "@/server/clientRecords";
import { loadImportLookups, resolveRows, type ResolvedImportRow } from "@/server/clientImportExtras";
import { lockClient, refreshCurrentSubscription } from "@/server/clientSubscriptionStore";

/** What this import may do beyond plain client records. */
/**
 * The amounts a file stated for a client (V5 §7), as stored on `Client.importedAmounts`: what the cell said, the
 * file and the time. A record only — never money owed or paid.
 */
function importedAmountRecords(row: ResolvedImportRow, fileName: string): Prisma.InputJsonValue[] {
  const at = new Date().toISOString();
  return (row.importedAmounts ?? []).map((a) => ({ ...a, file: fileName, at }) as unknown as Prisma.InputJsonValue);
}

export interface ImportOptions {
  /** The person may sell subscriptions and the sub-module is on: subscription columns are imported. */
  subscriptions: boolean;
  /**
   * What a file's own client code becomes on a NEW client (CLIENT_CODES.md §Import). REFERENCE (default): the
   * client gets the project's next code and the file's code is kept as an alias, so it still finds the client.
   * AS_CODE: the file's code IS the client's code — chosen explicitly, by someone who manages client settings.
   */
  codeMode?: "REFERENCE" | "AS_CODE";
}

/** What a failed row says: an actionable code refusal as it is, anything else as a plain failure. */
export function importRowFailure(err: unknown): string {
  if (err instanceof ClientCodeSeriesError) return err.message;
  return isUniqueViolation(err) ? "That client code is already used by another client." : "The row could not be saved.";
}

/** The file's rows, built (shared rules) and then resolved against this project's roster and lists. */
async function buildAndResolve(rows: readonly RawImportRow[], mapping: ClientImportMapping) {
  const built = buildImportRows(rows, mapping);
  const resolved = resolveRows(built.valid, await loadImportLookups());
  const invalid = [...built.invalid, ...resolved.invalid].sort((a, b) => a.rowNumber - b.rowNumber);
  return { valid: resolved.valid, invalid };
}

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
  /** Rows carrying a subscription, and whether those subscriptions will be imported. */
  subscriptionRows: number;
  subscriptionsImported: boolean;
}

/** The existing client a row matches, by any of its identifiers or its typed code. */
export function matchOf(row: ImportedClientRow, byKey: Map<string, string>, byCode: Map<string, string>): string | undefined {
  for (const key of row.matchKeys) {
    const id = byKey.get(key);
    if (id) return id;
  }
  return row.fields.code ? byCode.get(row.fields.code.toLowerCase()) : undefined;
}

export async function computeImportPreview(rows: readonly RawImportRow[], mapping: ClientImportMapping, options: ImportOptions = { subscriptions: false }): Promise<ImportPreview> {
  const built = await buildAndResolve(rows, mapping);
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
    subscriptionRows: built.valid.filter((r) => r.resolved.subscription).length,
    subscriptionsImported: options.subscriptions,
  };
}

/** Every row the import would refuse, with its reasons — for the "Download problem rows" file. Not capped. */
export async function listImportProblems(rows: readonly RawImportRow[], mapping: ClientImportMapping): Promise<Array<{ rowNumber: number; errors: string[] }>> {
  return (await buildAndResolve(rows, mapping)).invalid;
}

export interface ImportRunResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ rowNumber: number; errors: string[] }>;
}

/**
 * Smart Bulk Import's "expiry on record": an exact expiry the file gave with no start date. A fact about
 * the client, never a subscription term (SMART_IMPORT.md §11). Like a subscription, written only for a
 * person allowed to manage subscriptions. Nothing when the row has none (every other import).
 */
function recordedExpiryData(row: ResolvedImportRow, options: ImportOptions) {
  if (!options.subscriptions || !row.recordedExpiry) return {};
  return {
    recordedExpiryDate: new Date(`${row.recordedExpiry.date}T00:00:00.000Z`),
    recordedExpiryService: row.recordedExpiry.service?.slice(0, 120) ?? null,
    recordedExpiryAt: new Date(),
  };
}

/** Adds the row's subscription unless the client already has the same term (a re-imported file adds nothing twice). */
async function addImportedTerm(tx: Prisma.TransactionClient, clientId: string, row: ResolvedImportRow, actorUserId: string | null): Promise<boolean> {
  const term = row.resolved.subscription;
  if (!term) return false;
  await lockClient(tx, clientId);
  const start = new Date(`${term.startDate}T00:00:00.000Z`);
  const end = new Date(`${term.endDate}T00:00:00.000Z`);
  const same = await tx.clientSubscription.findFirst({ where: { clientId, service: term.service, startDate: start, endDate: end, cancelledAt: null }, select: { id: true } });
  if (same) return false;
  const hadBefore = (await tx.clientSubscription.count({ where: { clientId } })) > 0;
  await tx.clientSubscription.create({
    data: {
      clientId,
      service: term.service,
      kind: term.kind,
      startDate: start,
      endDate: end,
      durationValue: term.durationValue,
      durationUnit: term.durationUnit,
      isRenewal: hadBefore,
      ...(row.resolved.seller ?? {}),
      createdById: actorUserId,
    },
  });
  await refreshCurrentSubscription(tx, clientId);
  return true;
}

async function createRow(row: ResolvedImportRow, fileName: string, actorUserId: string | null, options: ImportOptions): Promise<void> {
  await prisma.$transaction((tx) => createImportedClient(tx, row, fileName, actorUserId, options));
}

/**
 * Creates the client a row describes, inside the caller's transaction — so Smart Bulk Import can record
 * the row's outcome in the same commit (SMART_IMPORT.md §2.5). Returns the new client's id.
 */
export async function createImportedClient(tx: Prisma.TransactionClient, row: ResolvedImportRow, fileName: string, actorUserId: string | null, options: ImportOptions): Promise<string> {
  {
    const projectId = await activeProjectId();
    const fileCode = row.fields.code?.trim() || null;
    const asCode = options.codeMode === "AS_CODE" && fileCode !== null;
    if (asCode) {
      const refusal = await typedClientCodeRefusal(tx, projectId, fileCode);
      if (refusal) throw new ClientCodeSeriesError(refusal);
    }
    const code = asCode ? fileCode : await nextClientCode(tx);
    const amounts = importedAmountRecords(row, fileName);
    const created = await tx.client.create({
      data: {
        ...(amounts.length ? { importedAmounts: amounts } : {}),
        ...(row.businessType ? { businessType: row.businessType } : {}),
        // Columns the person chose to keep (V5 §11) arrive as custom fields named after their headers.
        ...(Object.keys(row.fields.customFields ?? {}).length ? { customFields: row.fields.customFields } : {}),
        code,
        name: row.fields.name,
        companyName: row.fields.companyName,
        status: row.fields.status,
        category: row.fields.category,
        preferredLanguage: row.fields.preferredLanguage,
        address: row.fields.address,
        tags: row.fields.tags,
        country: row.resolved.country,
        preferredCurrency: row.resolved.preferredCurrency,
        assignedTeamId: row.resolved.assignedTeamId,
        assignedMemberId: row.resolved.assignedMemberId,
        soldByMemberId: row.resolved.soldByMemberId,
        source: "IMPORT",
        sourceDetail: fileName.slice(0, 200),
        ...recordedExpiryData(row, options),
        createdById: actorUserId,
        channels: { create: row.channels.map((c) => channelFields(c, "import")) },
      },
      select: { id: true },
    });
    await recordClientActivity(tx, created.id, actorUserId, { type: "IMPORTED", summary: `Imported from ${fileName.slice(0, 80)} (row ${row.rowNumber})` });
    // The file's own code stays the client's reference: searchable, and what a later import of the same file matches.
    // Already naming something in this project, it is left alone rather than made ambiguous.
    if (fileCode && !asCode && !(await clientCodeTaken(tx, projectId, fileCode, created.id))) {
      await recordClientCodeAlias(tx, { projectId, clientId: created.id, code: fileCode, reason: "IMPORT_SOURCE", actorUserId });
    }
    if (row.note) await tx.clientNote.create({ data: { clientId: created.id, body: row.note, authorId: actorUserId } });
    if (options.subscriptions && row.recordedExpiry) {
      await recordClientActivity(tx, created.id, actorUserId, { type: "EXPIRY_RECORDED", summary: `Expiry on record from the import: ${row.recordedExpiry.date}${row.recordedExpiry.service ? ` (${row.recordedExpiry.service})` : ""} — no start date, so not a subscription term` });
    }
    if (options.subscriptions && (await addImportedTerm(tx, created.id, row, actorUserId))) {
      await recordClientActivity(tx, created.id, actorUserId, { type: "SUBSCRIPTION_ADDED", summary: `Subscription imported: ${row.resolved.subscription!.service} (${row.resolved.subscription!.startDate} → ${row.resolved.subscription!.endDate})` });
    }
    return created.id;
  }
}

/** Applies the file's non-empty values to a client that already exists. Never un-archives, never resets a status the file did not give. */
async function updateRow(clientId: string, row: ResolvedImportRow, fileName: string, actorUserId: string | null, options: ImportOptions): Promise<"UPDATED" | "ARCHIVED"> {
  return prisma.$transaction((tx) => updateImportedClient(tx, clientId, row, fileName, actorUserId, options));
}

/** `updateRow`'s work inside the caller's transaction (see `createImportedClient`). */
export async function updateImportedClient(tx: Prisma.TransactionClient, clientId: string, row: ResolvedImportRow, fileName: string, actorUserId: string | null, options: ImportOptions): Promise<"UPDATED" | "ARCHIVED"> {
  {
    const current = await tx.client.findFirst({ where: { id: clientId }, include: { channels: { select: { kind: true, normalizedValue: true } } } });
    if (!current || current.status === "ARCHIVED") return "ARCHIVED" as const;
    const data: Prisma.ClientUpdateInput = {};
    const changed: string[] = [];
    // A derived value (V5: country from a number, currency and language from the country) only fills a gap: it
    // never replaces what the client already has, unlike a value the file itself gave.
    const derivedSkip = (key: "preferredLanguage" | "country" | "preferredCurrency") =>
      Boolean(current[key]) && ((key === "preferredLanguage" && row.derived?.language) || (key === "country" && row.derived?.country) || (key === "preferredCurrency" && row.derived?.currency));
    const set = <K extends "name" | "companyName" | "category" | "preferredLanguage" | "address">(key: K, value: string | null) => {
      if (key === "preferredLanguage" && derivedSkip("preferredLanguage")) return;
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
    // V3 columns: a value in the file replaces the client's; an empty cell leaves it alone.
    const setId = (column: "country" | "preferredCurrency" | "assignedTeamId" | "assignedMemberId" | "soldByMemberId", value: string | null, label: string) => {
      if ((column === "country" || column === "preferredCurrency") && derivedSkip(column)) return;
      if (value && value !== current[column]) {
        (data as Record<string, unknown>)[column === "assignedTeamId" ? "assignedTeam" : column === "assignedMemberId" ? "assignedMember" : column === "soldByMemberId" ? "soldByMember" : column] =
          column === "assignedTeamId" || column === "assignedMemberId" || column === "soldByMemberId" ? { connect: { id: value } } : value;
        changed.push(label);
      }
    };
    setId("country", row.resolved.country, "country");
    setId("preferredCurrency", row.resolved.preferredCurrency, "preferred currency");
    setId("assignedTeamId", row.resolved.assignedTeamId, "team");
    setId("assignedMemberId", row.resolved.assignedMemberId, "assigned staff");
    setId("soldByMemberId", row.resolved.soldByMemberId, "sold by");
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
    const newChannels = row.channels.filter((c) => !have.has(c.matchKey) && !(c.legacyMatchKey && have.has(c.legacyMatchKey)));
    if (newChannels.length) {
      // A new primary must not displace an existing one of the same kind.
      const primaryKinds = new Set((await tx.clientChannel.findMany({ where: { clientId, isPrimary: true }, select: { kind: true } })).map((c) => c.kind));
      await tx.clientChannel.createMany({ data: newChannels.map((c) => ({ clientId, ...channelFields({ ...c, isPrimary: c.isPrimary && !primaryKinds.has(c.kind) }, "import") })), skipDuplicates: true });
      changed.push("channels");
    }
    if (row.businessType && row.businessType !== current.businessType) {
      data.businessType = row.businessType;
      changed.push("business type");
    }
    // Kept columns: the file's value replaces that one custom field; every other custom field stays.
    const kept = row.fields.customFields ?? {};
    if (Object.keys(kept).length) {
      const existing = current.customFields && typeof current.customFields === "object" && !Array.isArray(current.customFields) ? (current.customFields as Record<string, string>) : {};
      const merged = { ...existing, ...kept };
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        data.customFields = merged;
        changed.push("custom fields");
      }
    }
    // Amounts this file states are added to what earlier files stated; the same cell from the same file is not added twice.
    const amounts = importedAmountRecords(row, fileName);
    if (amounts.length) {
      const before = Array.isArray(current.importedAmounts) ? (current.importedAmounts as Array<Record<string, unknown>>) : [];
      const seen = new Set(before.map((a) => `${a.file}|${a.column}|${a.original}`));
      const fresh = amounts.filter((a) => !seen.has(`${(a as Record<string, unknown>).file}|${(a as Record<string, unknown>).column}|${(a as Record<string, unknown>).original}`));
      if (fresh.length) {
        data.importedAmounts = [...(before as unknown as Prisma.InputJsonValue[]), ...fresh];
        changed.push("amounts recorded at import");
      }
    }
    if (Object.keys(data).length) await tx.client.update({ where: { id: clientId }, data });
    if (options.subscriptions && (await addImportedTerm(tx, clientId, row, actorUserId))) changed.push("subscription");
    if (options.subscriptions && row.recordedExpiry) {
      const same = current.recordedExpiryDate?.toISOString().slice(0, 10) === row.recordedExpiry.date && (current.recordedExpiryService ?? null) === row.recordedExpiry.service;
      if (!same) {
        await tx.client.update({ where: { id: clientId }, data: recordedExpiryData(row, options) });
        changed.push("expiry on record");
      }
    }
    // The same note is never added twice: re-importing a file must not stack copies of it.
    if (row.note && !(await tx.clientNote.findFirst({ where: { clientId, body: row.note }, select: { id: true } }))) {
      await tx.clientNote.create({ data: { clientId, body: row.note, authorId: actorUserId } });
      changed.push("note");
    }
    if (changed.length) await recordClientActivity(tx, clientId, actorUserId, { type: "IMPORT_UPDATED", summary: `Updated from ${fileName.slice(0, 80)}: ${changed.join(", ")}` });
    return "UPDATED" as const;
  }
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
  options: ImportOptions = { subscriptions: false },
): Promise<ImportRunResult> {
  const built = await buildAndResolve(rows, mapping);
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
        const outcome = await updateRow(matched, row, fileName, actorUserId, options);
        if (outcome === "UPDATED") result.updated += 1;
        else {
          result.skipped += 1;
          note(row.rowNumber, "Skipped: the matching client is archived. Restore it first.");
        }
      } else {
        // No match, or the administrator chose to create the client anyway.
        await createRow(row, fileName, actorUserId, options);
        result.imported += 1;
      }
    } catch (err) {
      result.failed += 1;
      note(row.rowNumber, importRowFailure(err));
    }
    done += 1;
    if (done % 100 === 0) await onProgress(result);
  }
  return result;
}
