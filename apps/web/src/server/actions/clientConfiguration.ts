"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import {
  CLIENT_CATALOG_KIND_LABELS,
  CLIENT_CONFIG_LIMITS,
  cleanCatalogName,
  isClientCatalogKind,
  isIsoCurrency,
  parseAliases,
  validatePlan,
  type ClientCatalogKindValue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isCountryCode } from "@/lib/clientPhone";

/**
 * Client Configuration Center actions (CLIENT_CONFIGURATION.md). Every one is a public endpoint and checks for
 * itself: `clients.manage_settings` (the Client Module settings key) inside the URL's project; every change is a
 * System Log entry. A list never takes a value away from a client: archiving hides an entry from pickers;
 * renaming or merging an entry renames that value on the clients that carry it, in the same transaction, and
 * says how many.
 */

export interface ConfigResult {
  ok: boolean;
  message: string;
  id?: string;
}

type Gate = { error: string } | { session: { userId: string } };

async function gate(): Promise<Gate> {
  const granted = await checkPermission("clients.manage_settings");
  if ("denied" in granted) return { error: granted.denied ?? "You do not have permission to change the client settings." };
  return { session: granted.session };
}

async function refresh() {
  for (const p of ["/settings/clients", "/settings/clients/configuration", "/clients", "/clients/new"]) revalidatePath(await projectPath(p));
}

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * The value `from` becomes `to` on every client of the project that carries it (case-insensitively), in `tx`.
 * Tags keep their order and are never duplicated; categories and business types are plain columns.
 */
async function renameOnClients(tx: Prisma.TransactionClient, projectId: string, kind: ClientCatalogKindValue, from: string, to: string): Promise<number> {
  if (from.toLowerCase() === to.toLowerCase() && from === to) return 0;
  if (kind === "TAG") {
    return tx.$executeRaw`
      UPDATE "Client" SET "tags" = ARRAY(
        SELECT t FROM unnest(array_replace("tags", ${from}, ${to})) WITH ORDINALITY AS u(t, i) GROUP BY t ORDER BY min(i)
      )
      WHERE "projectId" = ${projectId} AND ${from} = ANY("tags")`;
  }
  const column = kind === "CATEGORY" ? "category" : "businessType";
  const r = await tx.client.updateMany({ where: { [column]: { equals: from, mode: "insensitive" } }, data: { [column]: to } });
  return r.count;
}

// ── Tags, categories, business types ────────────────────────────────────────────────────────────

export async function saveCatalogEntry(input: { kind: string; id?: string; name: string; aliases?: string; color?: string | null }): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!isClientCatalogKind(input?.kind)) return { ok: false, message: "Choose a list." };
  const kind = input.kind;
  const label = CLIENT_CATALOG_KIND_LABELS[kind].one;
  const clean = cleanCatalogName(kind, input.name);
  if (!clean.ok) return { ok: false, message: clean.error };
  const aliases = parseAliases(input.aliases ?? "");
  if (!aliases.ok) return { ok: false, message: aliases.error };
  const color = typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : null;
  const projectId = await activeProjectId();
  try {
    if (!input.id) {
      if ((await prisma.clientCatalogEntry.count({ where: { kind } })) >= CLIENT_CONFIG_LIMITS.entries) return { ok: false, message: `A list can hold at most ${CLIENT_CONFIG_LIMITS.entries.toLocaleString()} entries.` };
      const created = await prisma.clientCatalogEntry.create({ data: { kind, name: clean.name, aliases: aliases.aliases, color } });
      await logSystemEvent("INFO", "clients", `${label} added: ${clean.name}`, { kind, id: created.id, aliases: aliases.aliases }, { actorUserId: g.session.userId, targetType: "ClientCatalogEntry", targetId: created.id });
      await refresh();
      return { ok: true, message: `${label} "${clean.name}" added.`, id: created.id };
    }
    const existing = await prisma.clientCatalogEntry.findFirst({ where: { id: input.id, kind } });
    if (!existing) return { ok: false, message: `That ${label.toLowerCase()} no longer exists.` };
    const renamed = await prisma.$transaction(async (tx) => {
      // Conditional on the name it had when read: a rename from another tab is not overwritten blindly.
      const updated = await tx.clientCatalogEntry.updateMany({ where: { id: existing.id, name: existing.name }, data: { name: clean.name, aliases: aliases.aliases, color } });
      if (updated.count === 0) return null;
      return existing.name === clean.name ? 0 : renameOnClients(tx, projectId, kind, existing.name, clean.name);
    });
    if (renamed === null) return { ok: false, message: `This ${label.toLowerCase()} was changed meanwhile. Reload and try again.` };
    await logSystemEvent("INFO", "clients", `${label} changed: ${existing.name} → ${clean.name}`, { kind, id: existing.id, from: existing.name, to: clean.name, clientsRenamed: renamed, aliases: aliases.aliases }, { actorUserId: g.session.userId, targetType: "ClientCatalogEntry", targetId: existing.id });
    await refresh();
    return { ok: true, message: renamed ? `Saved. ${renamed.toLocaleString()} client(s) now show "${clean.name}".` : "Saved.", id: existing.id };
  } catch (err) {
    if (isUnique(err)) return { ok: false, message: `There is already a ${label.toLowerCase()} called "${clean.name}". Merge into it instead.` };
    throw err;
  }
}

export async function setCatalogEntryArchived(id: string, archived: boolean): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const entry = await prisma.clientCatalogEntry.findFirst({ where: { id: String(id ?? "") } });
  if (!entry) return { ok: false, message: "That entry no longer exists." };
  await prisma.clientCatalogEntry.updateMany({ where: { id: entry.id }, data: { archivedAt: archived ? new Date() : null } });
  const label = CLIENT_CATALOG_KIND_LABELS[entry.kind as ClientCatalogKindValue].one;
  await logSystemEvent("INFO", "clients", `${label} ${archived ? "archived" : "restored"}: ${entry.name}`, { kind: entry.kind, id: entry.id }, { actorUserId: g.session.userId, targetType: "ClientCatalogEntry", targetId: entry.id });
  await refresh();
  return { ok: true, message: archived ? `"${entry.name}" is no longer offered. Clients that have it keep it.` : `"${entry.name}" is offered again.` };
}

/** `fromId` is folded into `intoId`: its clients get `into`'s name, and its name and aliases become `into`'s aliases. */
export async function mergeCatalogEntries(fromId: string, intoId: string): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!fromId || !intoId || fromId === intoId) return { ok: false, message: "Choose two different entries." };
  const [from, into] = await Promise.all([prisma.clientCatalogEntry.findFirst({ where: { id: fromId } }), prisma.clientCatalogEntry.findFirst({ where: { id: intoId } })]);
  if (!from || !into) return { ok: false, message: "One of these entries no longer exists." };
  if (from.kind !== into.kind) return { ok: false, message: "Only entries of the same list can be merged." };
  const kind = from.kind as ClientCatalogKindValue;
  const aliases = parseAliases([...into.aliases, from.name, ...from.aliases].filter((a) => a.toLowerCase() !== into.name.toLowerCase()));
  if (!aliases.ok) return { ok: false, message: aliases.error };
  const projectId = await activeProjectId();
  const moved = await prisma.$transaction(async (tx) => {
    const n = await renameOnClients(tx, projectId, kind, from.name, into.name);
    await tx.clientCatalogEntry.update({ where: { id: into.id }, data: { aliases: aliases.aliases } });
    await tx.clientCatalogEntry.delete({ where: { id: from.id } });
    return n;
  });
  const label = CLIENT_CATALOG_KIND_LABELS[kind].one;
  await logSystemEvent("INFO", "clients", `${label} merged: ${from.name} → ${into.name}`, { kind, from: from.name, into: into.name, clientsRenamed: moved }, { actorUserId: g.session.userId, targetType: "ClientCatalogEntry", targetId: into.id });
  await refresh();
  return { ok: true, message: `Merged. ${moved.toLocaleString()} client(s) moved from "${from.name}" to "${into.name}", which now also matches "${from.name}" on import.` };
}

/** Adds the values clients already carry as list entries (one click), so nothing typed before the list is lost. */
export async function addUsedValuesToCatalog(kind: string, names: string[]): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  if (!isClientCatalogKind(kind)) return { ok: false, message: "Choose a list." };
  const clean = [...new Set((Array.isArray(names) ? names : []).slice(0, CLIENT_CONFIG_LIMITS.entries).flatMap((n) => {
    const c = cleanCatalogName(kind, n);
    return c.ok ? [c.name] : [];
  }))];
  if (!clean.length) return { ok: false, message: "Nothing to add." };
  const existing = new Set((await prisma.clientCatalogEntry.findMany({ where: { kind }, select: { name: true } })).map((e) => e.name.toLowerCase()));
  const fresh = clean.filter((n) => !existing.has(n.toLowerCase()));
  let added = 0;
  for (const name of fresh) {
    try {
      await prisma.clientCatalogEntry.create({ data: { kind, name } });
      added += 1;
    } catch (err) {
      if (!isUnique(err)) throw err;
    }
  }
  await logSystemEvent("INFO", "clients", `${CLIENT_CATALOG_KIND_LABELS[kind].many} added from existing clients: ${added}`, { kind, added, names: fresh.slice(0, 50) }, { actorUserId: g.session.userId });
  await refresh();
  return { ok: true, message: `${added.toLocaleString()} added to ${CLIENT_CATALOG_KIND_LABELS[kind].many.toLowerCase()}.` };
}

/**
 * Adding one entry from the Add / Edit Client form ("+ Create …"). Same rules and permission as the
 * Configuration Center: only someone who may manage the client settings can grow a list.
 */
export async function quickCreateCatalogEntry(kind: string, name: string): Promise<ConfigResult & { name?: string }> {
  const r = await saveCatalogEntry({ kind, name });
  if (!r.ok) return r;
  const entry = r.id ? await prisma.clientCatalogEntry.findFirst({ where: { id: r.id }, select: { name: true } }) : null;
  return { ...r, name: entry?.name };
}

// ── Service plans ───────────────────────────────────────────────────────────────────────────────

export async function saveServicePlan(input: { id?: string; name: string; service?: string; defaultKind?: string; defaultDuration?: string; defaultUnit?: string; prices?: Array<{ currency: string; amount: string }>; aliases?: string }): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const v = validatePlan(input ?? { name: "" });
  if (!v.ok) return { ok: false, message: v.errors.join(" ") };
  const data = {
    name: v.plan.name,
    service: v.plan.service,
    defaultKind: v.plan.defaultKind,
    defaultDuration: v.plan.defaultDuration,
    defaultUnit: v.plan.defaultUnit,
    prices: v.plan.prices as unknown as Prisma.InputJsonValue,
    aliases: v.plan.aliases,
  };
  try {
    if (!input.id) {
      if ((await prisma.clientServicePlan.count()) >= CLIENT_CONFIG_LIMITS.plans) return { ok: false, message: `A project can hold at most ${CLIENT_CONFIG_LIMITS.plans} plans.` };
      const created = await prisma.clientServicePlan.create({ data });
      await logSystemEvent("INFO", "clients", `Service plan added: ${v.plan.name}`, { id: created.id, ...v.plan }, { actorUserId: g.session.userId, targetType: "ClientServicePlan", targetId: created.id });
      await refresh();
      return { ok: true, message: `Plan "${v.plan.name}" added.`, id: created.id };
    }
    const updated = await prisma.clientServicePlan.updateMany({ where: { id: input.id }, data });
    if (updated.count === 0) return { ok: false, message: "That plan no longer exists." };
    await logSystemEvent("INFO", "clients", `Service plan changed: ${v.plan.name}`, { id: input.id, ...v.plan }, { actorUserId: g.session.userId, targetType: "ClientServicePlan", targetId: input.id });
    await refresh();
    // A plan's name is copied onto each subscription when it is sold, so renaming one never rewrites history.
    return { ok: true, message: "Plan saved. Subscriptions already sold keep the name they were sold under.", id: input.id };
  } catch (err) {
    if (isUnique(err)) return { ok: false, message: `There is already a plan called "${v.plan.name}".` };
    throw err;
  }
}

export async function setServicePlanArchived(id: string, archived: boolean): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const plan = await prisma.clientServicePlan.findFirst({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!plan) return { ok: false, message: "That plan no longer exists." };
  await prisma.clientServicePlan.updateMany({ where: { id: plan.id }, data: { archivedAt: archived ? new Date() : null } });
  await logSystemEvent("INFO", "clients", `Service plan ${archived ? "archived" : "restored"}: ${plan.name}`, { id: plan.id }, { actorUserId: g.session.userId, targetType: "ClientServicePlan", targetId: plan.id });
  await refresh();
  return { ok: true, message: archived ? `"${plan.name}" is no longer offered. Subscriptions sold under it are unchanged.` : `"${plan.name}" is offered again.` };
}

// ── Currencies and countries ────────────────────────────────────────────────────────────────────

/** Puts a currency first in every picker of this project (adding it to the list, enabled, if it was not there). */
export async function setCurrencyFavorite(code: string, favorite: boolean): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const c = String(code ?? "").trim().toUpperCase();
  if (!isIsoCurrency(c)) return { ok: false, message: `${c.slice(0, 10)} is not an ISO 4217 currency code.` };
  const projectId = await activeProjectId();
  await prisma.clientBillingCurrency.upsert({ where: { projectId_code: { projectId, code: c } }, create: { code: c, enabled: true, favorite, addedById: g.session.userId }, update: { favorite } });
  await logSystemEvent("INFO", "clients", `Currency ${favorite ? "marked favourite" : "unmarked"}: ${c}`, { code: c, favorite }, { actorUserId: g.session.userId });
  await refresh();
  return { ok: true, message: favorite ? `${c} is shown first.` : `${c} is no longer a favourite.` };
}

export async function saveCountrySetting(input: { country: string; favorite?: boolean; currency?: string | null; language?: string | null }): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const country = String(input?.country ?? "").trim().toUpperCase();
  if (!isCountryCode(country)) return { ok: false, message: "Choose a country from the list." };
  const currency = input.currency ? String(input.currency).trim().toUpperCase() : null;
  if (currency && !isIsoCurrency(currency)) return { ok: false, message: `${currency.slice(0, 10)} is not an ISO 4217 currency code.` };
  const language = input.language ? String(input.language).replace(/\s+/g, " ").trim().slice(0, 40) || null : null;
  const projectId = await activeProjectId();
  const data = { favorite: input.favorite === true, currency, language };
  if (!data.favorite && !currency && !language) {
    await prisma.clientCountrySetting.deleteMany({ where: { country } });
  } else {
    await prisma.clientCountrySetting.upsert({ where: { projectId_country: { projectId, country } }, create: { country, ...data }, update: data });
  }
  await logSystemEvent("INFO", "clients", `Country setting changed: ${country}`, { country, ...data }, { actorUserId: g.session.userId });
  await refresh();
  return { ok: true, message: `Saved for ${country}.` };
}

/** Offers (or stops offering) a currency in this project's pickers. Records that already use it are unchanged. */
export async function setProjectCurrency(code: string, enabled: boolean): Promise<ConfigResult> {
  const g = await gate();
  if ("error" in g) return { ok: false, message: g.error };
  const c = String(code ?? "").trim().toUpperCase();
  if (!isIsoCurrency(c) && enabled) return { ok: false, message: `${c.slice(0, 10)} is not an ISO 4217 currency code.` };
  const projectId = await activeProjectId();
  if (enabled) await prisma.clientBillingCurrency.upsert({ where: { projectId_code: { projectId, code: c } }, create: { code: c, enabled: true, addedById: g.session.userId }, update: { enabled: true } });
  else await prisma.clientBillingCurrency.updateMany({ where: { code: c }, data: { enabled: false, favorite: false } });
  await logSystemEvent("INFO", "clients", `Currency ${enabled ? "offered" : "no longer offered"}: ${c}`, { code: c, enabled }, { actorUserId: g.session.userId });
  await refresh();
  return { ok: true, message: enabled ? `${c} is offered.` : `${c} is no longer offered. Records that use it keep it.` };
}
