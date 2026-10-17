import { normalizeCurrencyCode, type ImportedClientRow, type ImportExtras } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { countryOptions } from "@/lib/clientPhone";
import { clientViewerCaps } from "@/server/clientModule";
import type { Session } from "@/server/auth";

/**
 * Resolving the Clients V3 columns of an import against THIS project's own lists (CLIENTS_V3.md
 * §Import): a team by name, a seller or staff member by name or phone number, a country by name or
 * code, a currency by its code. Not a "use server" file. Every miss is a sentence on the row, never a
 * guess: an unknown or ambiguous name refuses the row rather than crediting the wrong person.
 */

export interface ImportLookups {
  teams: Map<string, { id: string; name: string; active: boolean }>;
  membersByName: Map<string, Array<{ id: string; name: string; active: boolean; teamId: string | null; teamName: string | null }>>;
  membersByPhone: Map<string, { id: string; name: string; active: boolean; teamId: string | null; teamName: string | null }>;
  countries: Map<string, string>;
}

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/\D/g, "");

export async function loadImportLookups(): Promise<ImportLookups> {
  const [teams, members] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true, status: true } }),
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, status: true, teamId: true, phoneNumber: true, team: { select: { name: true } } } }),
  ]);
  const lookups: ImportLookups = { teams: new Map(), membersByName: new Map(), membersByPhone: new Map(), countries: new Map() };
  for (const t of teams) lookups.teams.set(key(t.name), { id: t.id, name: t.name, active: t.status === "ACTIVE" });
  for (const m of members) {
    const entry = { id: m.id, name: m.name, active: m.status === "ACTIVE", teamId: m.teamId, teamName: m.team?.name ?? null };
    lookups.membersByName.set(key(m.name), [...(lookups.membersByName.get(key(m.name)) ?? []), entry]);
    const d = digits(m.phoneNumber);
    if (d.length >= 8) lookups.membersByPhone.set(d, entry);
  }
  for (const c of countryOptions()) {
    lookups.countries.set(key(c.name), c.code);
    lookups.countries.set(key(c.code), c.code);
  }
  // Common ways of writing a few countries that their official name does not cover.
  for (const [alias, code] of [["uae", "AE"], ["usa", "US"], ["uk", "GB"], ["ksa", "SA"], ["saudi", "SA"], ["bd", "BD"]] as const) lookups.countries.set(alias, code);
  return lookups;
}

export interface ResolvedExtras {
  country: string | null;
  preferredCurrency: string | null;
  assignedTeamId: string | null;
  assignedMemberId: string | null;
  soldByMemberId: string | null;
  seller: { soldByMemberId: string; soldByName: string; soldByTeamId: string | null; soldByTeamName: string | null } | null;
  subscription: ImportExtras["subscription"];
}

function findMember(text: string, lookups: ImportLookups, label: string): { id: string; name: string; active: boolean; teamId: string | null; teamName: string | null } | { error: string } {
  const d = digits(text);
  if (d.length >= 8) {
    const byPhone = lookups.membersByPhone.get(d) ?? lookups.membersByPhone.get(d.startsWith("0") ? `88${d}` : d);
    if (byPhone) return byPhone;
  }
  const byName = lookups.membersByName.get(key(text)) ?? [];
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) return { error: `${label} "${text}": ${byName.length} team members have that name. Write their phone number instead.` };
  return { error: `${label} "${text}" is not on this project's team roster (WhatsApp → Team Members).` };
}

/** One row's V3 values as ids, or the reasons it cannot be imported. */
export function resolveImportExtras(extras: ImportExtras, lookups: ImportLookups): { ok: true; value: ResolvedExtras } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let country: string | null = null;
  if (extras.country) {
    country = lookups.countries.get(key(extras.country)) ?? null;
    if (!country) errors.push(`Country "${extras.country}" is not recognised. Use the name from the Lists sheet, or a two-letter code such as BD.`);
  }
  let preferredCurrency: string | null = null;
  if (extras.currency) {
    preferredCurrency = normalizeCurrencyCode(extras.currency);
    if (!preferredCurrency) errors.push(`Preferred currency "${extras.currency}" must be a three-letter code, such as BDT or AED.`);
  }
  let assignedTeamId: string | null = null;
  if (extras.team) {
    const team = lookups.teams.get(key(extras.team));
    if (!team) errors.push(`Team "${extras.team}" does not exist in this project.`);
    else if (!team.active) errors.push(`Team "${team.name}" is disabled, so nobody new can be assigned to it.`);
    else assignedTeamId = team.id;
  }
  let assignedMemberId: string | null = null;
  if (extras.assignedTo) {
    const m = findMember(extras.assignedTo, lookups, "Assigned staff");
    if ("error" in m) errors.push(m.error);
    else if (!m.active) errors.push(`Assigned staff "${m.name}" is no longer active.`);
    else if (assignedTeamId && m.teamId !== assignedTeamId) errors.push(`Assigned staff "${m.name}" is not in the team ${extras.team}.`);
    else assignedMemberId = m.id;
  }
  let seller: ResolvedExtras["seller"] = null;
  if (extras.soldBy) {
    const m = findMember(extras.soldBy, lookups, "Sold by");
    if ("error" in m) errors.push(m.error);
    else if (!m.active) errors.push(`Sold by "${m.name}" is no longer active, so a sale cannot be credited to them.`);
    else {
      const teamActive = m.teamId ? [...lookups.teams.values()].find((t) => t.id === m.teamId)?.active : false;
      seller = { soldByMemberId: m.id, soldByName: m.name, soldByTeamId: teamActive ? m.teamId : null, soldByTeamName: teamActive ? m.teamName : null };
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { country, preferredCurrency, assignedTeamId, assignedMemberId, soldByMemberId: seller?.soldByMemberId ?? null, seller, subscription: extras.subscription } };
}

export type ResolvedImportRow = ImportedClientRow & { resolved: ResolvedExtras };

/** Splits built rows into resolved ones and rows refused with their reasons. */
export function resolveRows(rows: readonly ImportedClientRow[], lookups: ImportLookups): { valid: ResolvedImportRow[]; invalid: Array<{ rowNumber: number; errors: string[] }> } {
  const valid: ResolvedImportRow[] = [];
  const invalid: Array<{ rowNumber: number; errors: string[] }> = [];
  for (const row of rows) {
    const r = resolveImportExtras(row.extras, lookups);
    if (r.ok) valid.push({ ...row, resolved: r.value });
    else invalid.push({ rowNumber: row.rowNumber, errors: r.errors });
  }
  return { valid, invalid };
}

/** Subscription columns are imported only for someone who may sell subscriptions, with the sub-module on. */
export async function importOptionsFor(session: Session): Promise<{ subscriptions: boolean }> {
  const caps = await clientViewerCaps(session);
  return { subscriptions: caps.canManageSubscriptions };
}
