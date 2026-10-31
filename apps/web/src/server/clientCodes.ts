import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { clientCodeTaken, clientCodeTenantKey, readClientCodeSeries, reservedClientCodePrefixes } from "@support-automation/db";
import {
  canonicalClientCode,
  planCodeConversion,
  seriesOfCode,
  type CodePlan,
  type CodePlanOptions,
} from "@support-automation/shared";
import { globalPrisma } from "@/server/db";

/**
 * Client codes in the web app (CLIENT_CODES.md). Not a "use server" file: every caller has passed its own
 * permission check. Raw statements name their project; the series and alias tables are read across a
 * customer's projects only to keep prefixes and codes from colliding.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/**
 * Why a code typed by a person cannot be a client's code in this project, or null. It must be free in the
 * project (as a code and as an alias), and must not look like another project's codes ("N0042" belongs to the
 * project holding N) — a code is read by people, and two projects showing the same one invites mistakes.
 */
export async function typedClientCodeRefusal(db: Db, projectId: string, code: string, exceptClientId?: string | null): Promise<string | null> {
  if (await clientCodeTaken(db, projectId, code, exceptClientId)) return `The client code ${code} is already used in this project (by a client, or as a client's former code).`;
  const tenant = await clientCodeTenantKey(db, projectId);
  const others = (await reservedClientCodePrefixes(db, tenant)).filter((r) => r.projectId !== projectId);
  const holder = seriesOfCode(code, others.map((r) => r.prefix));
  if (holder !== null) {
    const project = others.find((r) => r.prefix === holder)!.projectName;
    return `${canonicalClientCode(code)} has the form of ${project}'s client codes (${holder || "numbers only"}). Choose a code that does not.`;
  }
  return null;
}

/** The client a code — current or former — names in this project, or null. Never more than one: both are unique. */
export async function clientIdForCode(db: Db, projectId: string, code: string): Promise<string | null> {
  const canonical = canonicalClientCode(code);
  if (!canonical) return null;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT c."id" FROM "Client" c WHERE c."projectId" = ${projectId} AND upper(c."code") = ${canonical}
    UNION ALL
    SELECT a."clientId" FROM "ClientCodeAlias" a WHERE a."projectId" = ${projectId} AND a."canonical" = ${canonical}
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** Former codes of these clients, for search and the profile ("formerly CL-000041"). */
export async function aliasesOf(db: Db, projectId: string, clientIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!clientIds.length) return out;
  const rows = await db.$queryRaw<Array<{ clientId: string; code: string; reason: string }>>`
    SELECT "clientId", "code", "reason" FROM "ClientCodeAlias"
     WHERE "projectId" = ${projectId} AND "clientId" = ANY(${[...clientIds]}::text[])
     ORDER BY "createdAt"`;
  for (const r of rows) out.set(r.clientId, [...(out.get(r.clientId) ?? []), r.code]);
  return out;
}

/** Records a code a client no longer has (or a file's own code). Inside the caller's transaction. */
export async function recordClientCodeAlias(
  db: Db,
  input: { projectId: string; clientId: string; code: string; reason: "CONVERSION" | "MANUAL_CHANGE" | "IMPORT_SOURCE"; replacedBy?: string | null; batchId?: string | null; actorUserId?: string | null },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "ClientCodeAlias" ("id", "projectId", "clientId", "code", "canonical", "reason", "replacedBy", "batchId", "changedById")
    VALUES (${`cca_${randomBytes(12).toString("hex")}`}, ${input.projectId}, ${input.clientId}, ${input.code.trim()}, ${canonicalClientCode(input.code)},
            ${input.reason}, ${input.replacedBy ?? null}, ${input.batchId ?? null}, ${input.actorUserId ?? null})`;
}

// ── Converting a project's existing codes (Main Admin, dry run then apply) ──────────────────────────────

export interface CodeConversionPreview {
  plan: CodePlan;
  series: { prefix: string; minWidth: number; nextSerial: string; version: number };
  counts: { clients: number; legacyPattern: number; custom: number; inSeries: number; archived: number };
}

async function conversionInputs(db: Db, projectId: string) {
  const series = (await readClientCodeSeries(db, projectId)).find((s) => !s.retiredAt);
  if (!series) return null;
  const clients = await db.$queryRaw<Array<{ id: string; code: string; createdAt: Date; archived: boolean }>>`
    SELECT "id", "code", "createdAt", ("archivedAt" IS NOT NULL OR "status" = 'ARCHIVED') AS "archived"
      FROM "Client" WHERE "projectId" = ${projectId}`;
  const aliases = await db.$queryRaw<Array<{ canonical: string }>>`SELECT "canonical" FROM "ClientCodeAlias" WHERE "projectId" = ${projectId}`;
  return { series: { prefix: series.prefix, minWidth: series.minWidth, nextSerial: series.nextSerial, version: series.version }, clients, aliases: aliases.map((a) => a.canonical) };
}

/** The dry run: what WOULD change. Reads only. */
export async function previewCodeConversion(projectId: string, options: CodePlanOptions, db: Db = globalPrisma): Promise<CodeConversionPreview | null> {
  const inputs = await conversionInputs(db, projectId);
  if (!inputs) return null;
  const plan = planCodeConversion({ ...inputs, options });
  return {
    plan,
    series: inputs.series,
    counts: {
      clients: plan.rows.length,
      legacyPattern: plan.rows.filter((r) => r.category === "LEGACY_PATTERN").length,
      custom: plan.rows.filter((r) => r.category === "CUSTOM").length,
      inSeries: plan.rows.filter((r) => r.category === "IN_SERIES").length,
      archived: plan.rows.filter((r) => r.archived).length,
    },
  };
}

/**
 * Applies exactly the plan the admin reviewed. In ONE transaction, holding the project's series row (so no client
 * can be created or given a code meanwhile — allocation waits on that row): recompute the plan, refuse unless its
 * hash is the reviewed one, then for each change write the alias, the new code and a timeline entry, and move the
 * series past every number used. Ids, invoices, receipts, payments and every link keep pointing at the same client;
 * issued documents are not touched. Returns the batch id the recovery script reverses.
 */
export async function applyCodeConversion(
  projectId: string,
  input: { options: CodePlanOptions; expectedHash: string; actorUserId: string },
): Promise<{ ok: true; batchId: string; changed: number } | { ok: false; error: string }> {
  return globalPrisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ProjectClientCodeSeries" WHERE "projectId" = ${projectId} AND "retiredAt" IS NULL FOR UPDATE`;
      if (!locked[0]) return { ok: false as const, error: "This project has no client code series yet." };
      const inputs = await conversionInputs(tx, projectId);
      if (!inputs) return { ok: false as const, error: "This project has no client code series yet." };
      const plan = planCodeConversion({ ...inputs, options: input.options });
      if (plan.hash !== input.expectedHash) {
        return { ok: false as const, error: "Clients or codes changed since the preview was made. Preview again, check it, then apply." };
      }
      const batchId = `ccb_${randomBytes(10).toString("hex")}`;
      const changes = plan.rows.filter((r): r is typeof r & { to: string } => Boolean(r.to));
      for (const row of changes) {
        await recordClientCodeAlias(tx, { projectId, clientId: row.clientId, code: row.from, reason: "CONVERSION", replacedBy: row.to, batchId, actorUserId: input.actorUserId });
        const updated = await tx.$executeRaw`UPDATE "Client" SET "code" = ${row.to}, "updatedAt" = now() WHERE "id" = ${row.clientId} AND "projectId" = ${projectId} AND "code" = ${row.from}`;
        if (updated !== 1) throw new Error(`Client ${row.clientId} changed during the conversion; nothing was applied.`);
        await tx.$executeRaw`
          INSERT INTO "ClientActivity" ("id", "projectId", "clientId", "actorUserId", "type", "summary", "details")
          VALUES (${`cact_${randomBytes(12).toString("hex")}`}, ${projectId}, ${row.clientId}, ${input.actorUserId}, 'CODE_CHANGED',
                  ${`Client code changed from ${row.from} to ${row.to}`}, ${JSON.stringify({ from: row.from, to: row.to, batchId })}::jsonb)`;
      }
      await tx.$executeRaw`
        UPDATE "ProjectClientCodeSeries" SET "nextSerial" = GREATEST("nextSerial", ${plan.nextSerialAfter}::numeric), "updatedAt" = now(), "updatedById" = ${input.actorUserId}
         WHERE "projectId" = ${projectId} AND "retiredAt" IS NULL`;
      return { ok: true as const, batchId, changed: changes.length };
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
}
