"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import {
  contactDisplayName,
  CONTACT_IDENTIFIER_LABEL,
  extractContactIdentifiers,
  formatContactSerial,
  guessContactImportMapping,
  isContactCampaignChannel,
  isContactConsent,
  isContactIdentifierKind,
  isContactImportField,
  MAX_CONTACT_CAMPAIGN_BODY,
  MAX_CONTACT_CAMPAIGN_RECIPIENTS,
  MAX_CONTACT_IMPORT_ROWS,
  normalizeContactIdentifier,
  parseConversationRef,
  readContactFields,
  readContactImportRows,
  readContactTags,
  renderContactCampaignText,
  unknownCampaignVariables,
  type ContactConsentValue,
  type ContactIdentifierKindValue,
  type ContactImportField,
  type ContactImportRow,
} from "@support-automation/shared";
import { reserveContactSerials } from "@support-automation/db";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { conversationInProject } from "@/server/inboxWorkspace";
import { emailChannelReady } from "@/server/clientMessages";
import { sendPersonalChatMessage } from "@/server/actions/chat";
import { sendChannelReplyAction } from "@/server/actions/channelInbox";
import {
  actorOf,
  collectFromConversation,
  eventRow,
  conversationFacts,
  loadCampaign,
  queueCampaignEmails,
  readCampaignAudience,
  readContactFilters,
  saveContactImportRows,
  searchContactOptions,
  selectionWhere,
  summariseAudience,
  type ContactImportResult,
  type ContactSelection,
} from "@/server/contacts";

/**
 * Contacts (CONTACTS.md). Each action checks its own key; every read goes through the project-scoped client, so another
 * project's id is simply not found. Nothing here writes to a Client, a due or a subscription: linking only stores a
 * pointer on the contact, and importing from the client list only reads.
 */

type Fail = { error: string };
const FEATURE = "CONTACTS" as const;

async function refresh(id?: string) {
  revalidatePath(await projectPath("/contacts"));
  if (id) revalidatePath(await projectPath(`/contacts/${id}`));
}

const isUnique = (err: unknown) => (err as { code?: string }).code === "P2002";

function readSelection(raw: unknown): ContactSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { ids?: unknown; filters?: unknown };
  if (Array.isArray(r.ids)) return { ids: r.ids.filter((x): x is string => typeof x === "string").slice(0, MAX_CONTACT_CAMPAIGN_RECIPIENTS) };
  if (r.filters && typeof r.filters === "object") return { filters: readContactFilters(r.filters as Record<string, unknown>) };
  return null;
}

async function holderLabel(contactId: string): Promise<string> {
  const c = await prisma.contact.findFirst({ where: { id: contactId }, select: { serial: true, name: true, company: true } });
  return c ? `${formatContactSerial(c.serial)} (${contactDisplayName(c)})` : "another contact";
}

type RawValue = { kind: unknown; value: unknown };

function readValues(raw: unknown): Array<{ kind: ContactIdentifierKindValue; value: string; normalized: string }> | Fail {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ kind: ContactIdentifierKindValue; value: string; normalized: string }> = [];
  for (const item of raw.slice(0, 40) as RawValue[]) {
    if (!isContactIdentifierKind(item?.kind) || typeof item.value !== "string") return { error: "One of those values could not be read." };
    if (!item.value.trim()) continue;
    const reading = normalizeContactIdentifier(item.kind, item.value);
    if ("error" in reading) return reading;
    out.push(reading);
  }
  return out;
}

// ── One contact ─────────────────────────────────────────────────────────────────────────────────

export async function createContact(input: Record<string, unknown>): Promise<{ id: string; label: string } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const fields = readContactFields(input);
  if ("error" in fields) return fields;
  const values = readValues(input.values);
  if ("error" in values) return values;
  if (!fields.name && !fields.company && values.length === 0) return { error: "Enter a name, a number or an address." };

  const known = values.length ? await prisma.contactIdentifier.findFirst({ where: { OR: values.map((v) => ({ kind: v.kind, normalized: v.normalized })) }, select: { contactId: true, value: true } }) : null;
  if (known) return { error: `${known.value} is already saved on ${await holderLabel(known.contactId)}.` };

  const actor = actorOf(granted.session);
  const projectId = await activeProjectId();
  try {
    const created = await prisma.$transaction(async (tx) => {
      const serial = await reserveContactSerials(tx, projectId, 1);
      const row = await tx.contact.create({ data: { ...fields, serial, source: "MANUAL", createdById: actor.userId, consent: isContactConsent(input.consent) ? input.consent : "UNKNOWN" }, select: { id: true } });
      if (values.length) await tx.contactIdentifier.createMany({ data: values.map((v) => ({ contactId: row.id, ...v, source: "MANUAL" as const })) });
      await tx.contactEvent.create({ data: eventRow(row.id, "CREATED", "Added by hand", actor) });
      return { id: row.id, serial };
    });
    await refresh();
    return { id: created.id, label: formatContactSerial(created.serial) };
  } catch (err) {
    if (isUnique(err)) return { error: "That code or value was saved on another contact a moment ago. Check the list and try again." };
    throw err;
  }
}

export async function updateContact(id: string, input: Record<string, unknown>): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const fields = readContactFields(input);
  if ("error" in fields) return fields;
  try {
    const done = await prisma.$transaction(async (tx) => {
      const changed = await tx.contact.updateMany({ where: { id }, data: fields });
      if (changed.count === 0) return false;
      await tx.contactEvent.create({ data: eventRow(id, "EDITED", "Details changed", actorOf(granted.session)) });
      return true;
    });
    if (!done) return { error: "That contact is no longer here." };
  } catch (err) {
    if (isUnique(err)) return { error: "Another contact already has that code." };
    throw err;
  }
  await refresh(id);
  return { ok: true };
}

export async function addContactValues(id: string, raw: unknown): Promise<{ added: number; heldElsewhere: string[] } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const values = readValues(raw);
  if ("error" in values) return values;
  if (values.length === 0) return { error: "Nothing to add." };
  const contact = await prisma.contact.findFirst({ where: { id }, select: { id: true } });
  if (!contact) return { error: "That contact is no longer here." };

  const actor = actorOf(granted.session);
  const known = await prisma.contactIdentifier.findMany({ where: { OR: values.map((v) => ({ kind: v.kind, normalized: v.normalized })) }, select: { kind: true, normalized: true, contactId: true, value: true } });
  const fresh = values.filter((v) => !known.some((k) => k.kind === v.kind && k.normalized === v.normalized));
  if (fresh.length) {
    await prisma.$transaction([
      prisma.contactIdentifier.createMany({ data: fresh.map((v) => ({ contactId: id, ...v, source: "MANUAL" as const })), skipDuplicates: true }),
      prisma.contactEvent.createMany({ data: fresh.map((v) => eventRow(id, "VALUE_ADDED", v.value, actor)) }),
    ]);
  }
  const elsewhere = known.filter((k) => k.contactId !== id);
  const heldElsewhere = await Promise.all(elsewhere.map(async (k) => `${k.value} is already on ${await holderLabel(k.contactId)}`));
  await refresh(id);
  return { added: fresh.length, heldElsewhere };
}

export async function removeContactValue(valueId: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const row = await prisma.contactIdentifier.findFirst({ where: { id: valueId }, select: { id: true, contactId: true, kind: true, value: true } });
  if (!row) return { error: "That value is no longer here." };
  await prisma.$transaction([
    prisma.contactIdentifier.deleteMany({ where: { id: row.id } }),
    prisma.contactEvent.create({ data: eventRow(row.contactId, "VALUE_REMOVED", `${CONTACT_IDENTIFIER_LABEL[row.kind as ContactIdentifierKindValue]}: ${row.value}`, actorOf(granted.session)) }),
  ]);
  await refresh(row.contactId);
  return { ok: true };
}

export async function setContactConsent(id: string, consent: unknown): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if (!isContactConsent(consent)) return { error: "Choose an answer." };
  const changed = await prisma.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({ where: { id, NOT: { consent } }, data: { consent } });
    if (r.count) await tx.contactEvent.create({ data: eventRow(id, "CONSENT", consent, actorOf(granted.session)) });
    return r.count;
  });
  if (changed) await refresh(id);
  return { ok: true };
}

export async function setContactArchived(id: string, archived: boolean): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const status = archived ? "ARCHIVED" : "ACTIVE";
  await prisma.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({ where: { id, NOT: { status } }, data: { status } });
    if (r.count) await tx.contactEvent.create({ data: eventRow(id, archived ? "ARCHIVED" : "RESTORED", null, actorOf(granted.session)) });
  });
  await refresh(id);
  return { ok: true };
}

/** Erases a contact for good. Only one already archived, so nothing goes in a single press. */
export async function deleteContact(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.delete", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const r = await prisma.contact.deleteMany({ where: { id, status: "ARCHIVED" } });
  if (r.count === 0) return { error: "Archive a contact before deleting it." };
  await refresh();
  return { ok: true };
}

/** Links to a client record, or clears the link. Only a pointer: the client, its dues and subscriptions are not touched. */
export async function linkContactToClient(id: string, clientId: string | null): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if ((await activeDisabledFeatures()).has("CLIENT_CENTER") || !(await hasPermission(granted.session, "clients.view"))) return { error: "You cannot see the client list, so you cannot link to it." };
  const client = clientId ? await prisma.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }) : null;
  if (clientId && !client) return { error: "That client is not in this project." };
  await prisma.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({ where: { id }, data: { linkedClientId: client?.id ?? null } });
    if (r.count) await tx.contactEvent.create({ data: eventRow(id, client ? "CLIENT_LINKED" : "CLIENT_UNLINKED", client?.name ?? null, actorOf(granted.session)) });
  });
  await refresh(id);
  return { ok: true };
}

export async function searchClientsForContact(q: string): Promise<Array<{ id: string; name: string; code: string }>> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted || !(await hasPermission(granted.session, "clients.view")) || (await activeDisabledFeatures()).has("CLIENT_CENTER")) return [];
  const term = q.trim().slice(0, 80);
  if (term.length < 2) return [];
  return prisma.client.findMany({
    where: { archivedAt: null, OR: [{ name: { contains: term, mode: "insensitive" } }, { code: { contains: term, mode: "insensitive" } }] },
    orderBy: { name: "asc" },
    take: 12,
    select: { id: true, name: true, code: true },
  });
}

export async function searchContacts(q: string, excludeId?: string) {
  const granted = await checkPermission("contacts.view", FEATURE);
  if ("denied" in granted || q.trim().length < 2) return [];
  return searchContactOptions(q.trim().slice(0, 80), excludeId);
}

/**
 * Two records of one person become one. Numbers, chats and campaign rows move to the one kept, its blanks are filled and
 * nothing it already holds is overwritten. Someone who said no to offers stays that way, whichever record said it.
 */
export async function mergeContacts(sourceId: string, targetId: string): Promise<{ id: string } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if (sourceId === targetId) return { error: "Choose a different contact." };
  const actor = actorOf(granted.session);
  const done = await prisma.$transaction(
    async (tx) => {
      const [source, target] = await Promise.all([tx.contact.findFirst({ where: { id: sourceId } }), tx.contact.findFirst({ where: { id: targetId } })]);
      if (!source || !target) return false;
      await tx.contactIdentifier.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } });
      await tx.contactConversationLink.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } });
      const shared = await tx.contactCampaignRecipient.findMany({ where: { contactId: targetId }, select: { campaignId: true } });
      await tx.contactCampaignRecipient.deleteMany({ where: { contactId: sourceId, campaignId: { in: shared.map((s) => s.campaignId) } } });
      await tx.contactCampaignRecipient.updateMany({ where: { contactId: sourceId }, data: { contactId: targetId } });

      const history = await tx.contactEvent.findMany({ where: { contactId: sourceId }, orderBy: { createdAt: "asc" }, take: 200 });
      if (history.length) await tx.contactEvent.createMany({ data: history.map((e) => ({ contactId: targetId, kind: e.kind, detail: e.detail, actorUserId: e.actorUserId, actorName: e.actorName, createdAt: e.createdAt })) });

      const tags = [...target.tags];
      for (const t of source.tags) if (tags.length < 20 && !tags.some((have) => have.toLowerCase() === t.toLowerCase())) tags.push(t);
      const notes = [target.notes, source.notes].filter(Boolean).join("\n\n").slice(0, 10000) || null;
      const consent: ContactConsentValue = source.consent === "OPTED_OUT" || target.consent === "OPTED_OUT" ? "OPTED_OUT" : source.consent === "OPTED_IN" || target.consent === "OPTED_IN" ? "OPTED_IN" : "UNKNOWN";
      await tx.contact.deleteMany({ where: { id: sourceId } });
      await tx.contact.updateMany({
        where: { id: targetId },
        data: {
          tags, notes, consent,
          name: target.name ?? source.name, company: target.company ?? source.company, jobTitle: target.jobTitle ?? source.jobTitle, address: target.address ?? source.address, city: target.city ?? source.city, country: target.country ?? source.country,
          mapUrl: target.mapUrl ?? source.mapUrl, birthday: target.birthday ?? source.birthday, code: target.code ?? source.code, linkedClientId: target.linkedClientId ?? source.linkedClientId,
          latitude: target.latitude ?? (target.longitude === null ? source.latitude : null), longitude: target.longitude ?? (target.latitude === null ? source.longitude : null),
        },
      });
      await tx.contactEvent.create({ data: eventRow(targetId, "MERGED", `${formatContactSerial(source.serial)} (${contactDisplayName(source)}) merged into this contact`, actor) });
      return true;
    },
    { timeout: 30_000 },
  );
  if (!done) return { error: "One of those contacts is no longer here." };
  await refresh(targetId);
  return { id: targetId };
}

// ── Beside a chat ───────────────────────────────────────────────────────────────────────────────

/** Saves what a person pasted or chose beside a chat: the chat's own contact, created if it has none. */
export async function saveChatContact(rawRef: unknown, input: { name?: unknown; values?: unknown }): Promise<{ id: string; label: string; created: boolean; added: number; heldElsewhere: string[] } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const ref = parseConversationRef(rawRef);
  if (!ref || !(await conversationInProject(ref, await activeDisabledFeatures()))) return { error: "That conversation is not in this project." };
  const values = readValues(input.values);
  if ("error" in values) return values;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : null;
  try {
    const result = await collectFromConversation(granted.session, ref, { name, values });
    await refresh(result.contactId);
    const heldElsewhere = await Promise.all(result.heldElsewhere.map(async (h) => `${h.value} is already on ${await holderLabel(h.contactId)}`));
    return { id: result.contactId, label: formatContactSerial(result.serial), created: result.created, added: result.added.length, heldElsewhere };
  } catch (err) {
    if (isUnique(err)) return { error: "Someone saved this a moment ago. Refresh and try again." };
    throw err;
  }
}

/** Puts this chat on an existing contact, moving it off any other. A chat belongs to one contact. */
export async function linkChatToContact(rawRef: unknown, contactId: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const ref = parseConversationRef(rawRef);
  if (!ref || !(await conversationInProject(ref, await activeDisabledFeatures()))) return { error: "That conversation is not in this project." };
  const contact = await prisma.contact.findFirst({ where: { id: contactId }, select: { id: true } });
  if (!contact) return { error: "That contact is no longer here." };
  const facts = await conversationFacts(ref);
  const actor = actorOf(granted.session);
  const where = ref.kind === "whatsapp" ? { chatId: ref.chatId } : { channelConversationId: ref.conversationId };
  await prisma.$transaction(async (tx) => {
    await tx.contactConversationLink.deleteMany({ where });
    await tx.contactConversationLink.create({ data: { contactId, source: facts.source, title: facts.title, ...facts.chat } });
    await tx.contactEvent.create({ data: eventRow(contactId, "CHAT_LINKED", facts.title, actor) });
  });
  await refresh(contactId);
  return { ok: true };
}

export async function unlinkChatFromContact(rawRef: unknown): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const ref = parseConversationRef(rawRef);
  if (!ref) return { error: "That conversation could not be read." };
  const where = ref.kind === "whatsapp" ? { chatId: ref.chatId } : { channelConversationId: ref.conversationId };
  const link = await prisma.contactConversationLink.findFirst({ where, select: { id: true, contactId: true, title: true } });
  if (!link) return { ok: true };
  await prisma.$transaction([prisma.contactConversationLink.deleteMany({ where: { id: link.id } }), prisma.contactEvent.create({ data: eventRow(link.contactId, "CHAT_UNLINKED", link.title, actorOf(granted.session)) })]);
  await refresh(link.contactId);
  return { ok: true };
}

/** Saves a note beside a chat without opening the profile. */
export async function saveContactNotes(id: string, notes: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if (notes.length > 10000) return { error: "Notes can be up to 10,000 characters." };
  const changed = await prisma.$transaction(async (tx) => {
    const r = await tx.contact.updateMany({ where: { id }, data: { notes: notes.trim() || null } });
    if (r.count) await tx.contactEvent.create({ data: eventRow(id, "EDITED", "Notes changed", actorOf(granted.session)) });
    return r.count;
  });
  if (!changed) return { error: "That contact is no longer here." };
  await refresh(id);
  return { ok: true };
}

// ── Many at once ────────────────────────────────────────────────────────────────────────────────

export type ContactBulkOp =
  | { op: "addTag"; tag: string }
  | { op: "removeTag"; tag: string }
  | { op: "archive" }
  | { op: "restore" }
  | { op: "consent"; consent: ContactConsentValue }
  | { op: "delete" };

export async function bulkUpdateContacts(rawSelection: unknown, op: ContactBulkOp): Promise<{ changed: number } | Fail> {
  const granted = await checkPermission(op.op === "delete" ? "contacts.delete" : "contacts.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const selection = readSelection(rawSelection);
  if (!selection) return { error: "Nothing was selected." };
  const projectId = await activeProjectId();
  const actor = actorOf(granted.session);
  const ids = (await prisma.contact.findMany({ where: selectionWhere(selection), select: { id: true }, take: MAX_CONTACT_CAMPAIGN_RECIPIENTS })).map((c) => c.id);
  if (ids.length === 0) return { changed: 0 };

  if (op.op === "delete") {
    const r = await prisma.contact.deleteMany({ where: { id: { in: ids }, status: "ARCHIVED" } });
    await refresh();
    return { changed: r.count };
  }

  const changed = await prisma.$transaction(
    async (tx) => {
      if (op.op === "addTag" || op.op === "removeTag") {
        const [tag] = readContactTags([op.tag]);
        if (!tag) return 0;
        const rows =
          op.op === "addTag"
            ? await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Contact" SET "tags" = array_append("tags", ${tag}), "updatedAt" = now() WHERE "projectId" = ${projectId} AND "id" = ANY(${ids}) AND NOT (${tag} = ANY("tags")) AND cardinality("tags") < 20 RETURNING "id"`
            : await tx.$queryRaw<Array<{ id: string }>>`UPDATE "Contact" SET "tags" = array_remove("tags", ${tag}), "updatedAt" = now() WHERE "projectId" = ${projectId} AND "id" = ANY(${ids}) AND ${tag} = ANY("tags") RETURNING "id"`;
        if (rows.length) await tx.contactEvent.createMany({ data: rows.map((r) => eventRow(r.id, "EDITED", `${op.op === "addTag" ? "Tag added" : "Tag removed"}: ${tag}`, actor)) });
        return rows.length;
      }
      if (op.op === "consent") {
        if (!isContactConsent(op.consent)) return 0;
        const targets = await tx.contact.findMany({ where: { id: { in: ids }, NOT: { consent: op.consent } }, select: { id: true } });
        await tx.contact.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { consent: op.consent } });
        if (targets.length) await tx.contactEvent.createMany({ data: targets.map((t) => eventRow(t.id, "CONSENT", op.consent, actor)) });
        return targets.length;
      }
      const status = op.op === "archive" ? "ARCHIVED" : "ACTIVE";
      const targets = await tx.contact.findMany({ where: { id: { in: ids }, NOT: { status } }, select: { id: true } });
      await tx.contact.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { status } });
      if (targets.length) await tx.contactEvent.createMany({ data: targets.map((t) => eventRow(t.id, op.op === "archive" ? "ARCHIVED" : "RESTORED", null, actor)) });
      return targets.length;
    },
    { timeout: 30_000 },
  );
  await refresh();
  return { changed };
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

const MAX_FILE = 15 * 1024 * 1024;

function readGrid(buffer: Buffer, isCsv: boolean): unknown[][] | Fail {
  const limit = { sheetRows: MAX_CONTACT_IMPORT_ROWS + 2, cellFormula: false, cellHTML: false, cellStyles: false };
  let workbook: XLSX.WorkBook;
  try {
    workbook = isCsv ? XLSX.read(new TextDecoder("utf-8").decode(buffer), { type: "string", raw: true, ...limit }) : XLSX.read(buffer, { type: "buffer", ...limit });
  } catch {
    return { error: "That file could not be read. Save it as .xlsx or .csv and try again." };
  }
  // The first sheet with data, not simply the first sheet.
  for (const name of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, { header: 1, raw: false, defval: "", blankrows: false });
    if (grid.length >= 2) return grid;
  }
  return { error: "The file needs a header row and at least one contact." };
}

async function fileGrid(form: FormData): Promise<{ grid: unknown[][]; fileName: string } | Fail> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
  if (file.size > MAX_FILE) return { error: "That file is over 15 MB." };
  const name = file.name.toLowerCase();
  if (!/\.(csv|xlsx|xls)$/.test(name)) return { error: "Choose a .csv or .xlsx file." };
  const grid = readGrid(Buffer.from(await file.arrayBuffer()), name.endsWith(".csv"));
  return "error" in grid ? grid : { grid, fileName: file.name };
}

export interface ContactImportPreview {
  headers: string[];
  mapping: Array<ContactImportField | "">;
  sample: string[][];
  rows: number;
  truncated: boolean;
}

export async function previewContactImport(form: FormData): Promise<ContactImportPreview | Fail> {
  const granted = await checkPermission("contacts.import", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const read = await fileGrid(form);
  if ("error" in read) return read;
  const headers = (read.grid[0] ?? []).map((h, i) => String(h ?? "").trim().slice(0, 80) || `Column ${i + 1}`).slice(0, 60);
  const body = read.grid.slice(1);
  return { headers, mapping: guessContactImportMapping(headers), sample: body.slice(0, 5).map((r) => headers.map((_, i) => String(r[i] ?? "").slice(0, 80))), rows: Math.min(body.length, MAX_CONTACT_IMPORT_ROWS), truncated: body.length > MAX_CONTACT_IMPORT_ROWS };
}

export async function runContactImport(form: FormData): Promise<ContactImportResult | Fail> {
  const granted = await checkPermission("contacts.import", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const read = await fileGrid(form);
  if ("error" in read) return read;
  let mapping: Array<ContactImportField | "">;
  try {
    const parsed = JSON.parse(String(form.get("mapping") ?? "[]")) as unknown[];
    mapping = parsed.slice(0, 60).map((m) => (isContactImportField(m) ? m : ""));
  } catch {
    return { error: "The columns could not be read. Choose the file again." };
  }
  if (!mapping.some(Boolean)) return { error: "Choose at least one column." };
  const rows = readContactImportRows(read.grid.slice(1, MAX_CONTACT_IMPORT_ROWS + 1), mapping);
  const tag = readContactTags([form.get("tag") ?? ""])[0];
  if (tag) for (const row of rows) if (!row.fields.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) row.fields.tags.push(tag);
  const result = await saveContactImportRows(rows, { source: "IMPORT", sourceDetail: read.fileName.slice(0, 200), actor: actorOf(granted.session) });
  await refresh();
  return result;
}

const CLIENT_KIND: Record<string, { kind: ContactIdentifierKindValue; isWhatsApp: boolean } | undefined> = {
  PHONE: { kind: "PHONE", isWhatsApp: false },
  WHATSAPP: { kind: "PHONE", isWhatsApp: true },
  EMAIL: { kind: "EMAIL", isWhatsApp: false },
  MESSENGER: { kind: "FACEBOOK", isWhatsApp: false },
  INSTAGRAM: { kind: "INSTAGRAM", isWhatsApp: false },
  TELEGRAM: { kind: "TELEGRAM", isWhatsApp: false },
};

/** Copies the client list into Contacts. Reads clients only; each contact remembers which client it came from. */
export async function importFromClientList(): Promise<ContactImportResult | Fail> {
  const granted = await checkPermission("contacts.import", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if ((await activeDisabledFeatures()).has("CLIENT_CENTER") || !(await hasPermission(granted.session, "clients.view"))) return { error: "You cannot see the client list, so you cannot import from it." };
  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: "asc" },
    take: MAX_CONTACT_IMPORT_ROWS,
    select: { id: true, name: true, companyName: true, address: true, country: true, tags: true, channels: { select: { kind: true, value: true } } },
  });
  const clientOf = new Map<ContactImportRow, string>();
  const rows = clients.map((c, index) => {
    const identifiers: ContactImportRow["identifiers"] = [];
    for (const channel of c.channels) {
      const mapped = CLIENT_KIND[channel.kind];
      if (!mapped) continue;
      const reading = normalizeContactIdentifier(mapped.kind, channel.value);
      if ("error" in reading) continue;
      const same = identifiers.find((i) => i.kind === reading.kind && i.normalized === reading.normalized);
      if (same) same.isWhatsApp ||= mapped.isWhatsApp;
      else identifiers.push({ ...reading, isWhatsApp: mapped.isWhatsApp });
    }
    const row: ContactImportRow = {
      line: index + 1,
      fields: { name: c.name, code: null, company: c.companyName, jobTitle: null, address: c.address, city: null, country: c.country, mapUrl: null, latitude: null, longitude: null, birthday: null, notes: null, tags: readContactTags(c.tags) },
      consent: null,
      identifiers,
      problems: [],
    };
    clientOf.set(row, c.id);
    return row;
  });
  const result = await saveContactImportRows(rows, { source: "CLIENT_LIST", sourceDetail: "Client list", actor: actorOf(granted.session), clientIdOf: (row) => clientOf.get(row) ?? null });
  await refresh();
  return result;
}

// ── Campaigns ───────────────────────────────────────────────────────────────────────────────────

export async function previewCampaignAudience(input: { selection: unknown; channel: unknown; includeUnknown: unknown }) {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const selection = readSelection(input.selection);
  if (!selection || !isContactCampaignChannel(input.channel)) return { error: "Choose who and how." };
  return summariseAudience(await readCampaignAudience(selection, input.channel, input.includeUnknown === true));
}

export async function createContactCampaign(input: { name: unknown; channel: unknown; subject: unknown; body: unknown; includeUnknown: unknown; selection: unknown }): Promise<{ id: string } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : "";
  if (!name) return { error: "Give the campaign a name." };
  if (!isContactCampaignChannel(input.channel)) return { error: "Choose a channel." };
  const channel = input.channel;
  if (!body) return { error: "Write the message." };
  if (body.length > MAX_CONTACT_CAMPAIGN_BODY) return { error: `The message can be up to ${MAX_CONTACT_CAMPAIGN_BODY.toLocaleString("en-US")} characters.` };
  if (channel === "EMAIL" && !subject) return { error: "An email needs a subject." };
  const unknown = unknownCampaignVariables(`${subject} ${body}`);
  if (unknown.length) return { error: `{{${unknown[0]}}} is not something a contact can fill in. Use {{name}}, {{first_name}}, {{company}} or {{serial}}.` };
  const selection = readSelection(input.selection);
  if (!selection) return { error: "Choose who it goes to." };

  const audience = await readCampaignAudience(selection, channel, input.includeUnknown === true);
  if (audience.length > MAX_CONTACT_CAMPAIGN_RECIPIENTS) return { error: `A campaign can reach at most ${MAX_CONTACT_CAMPAIGN_RECIPIENTS.toLocaleString("en-US")} people. Narrow the list.` };
  if (!audience.some((a) => !a.skipReason)) return { error: "Nobody in that list can be reached this way." };

  const actor = actorOf(granted.session);
  const id = await prisma.$transaction(
    async (tx) => {
      const campaign = await tx.contactCampaign.create({ data: { name, channel, subject: subject || null, body, createdById: actor.userId, createdByName: actor.name }, select: { id: true } });
      await tx.contactCampaignRecipient.createMany({ data: audience.map((a) => ({ campaignId: campaign.id, contactId: a.contactId, toValue: a.toValue, status: a.skipReason ? ("SKIPPED" as const) : ("PENDING" as const), skipReason: a.skipReason })) });
      return campaign.id;
    },
    { timeout: 30_000 },
  );
  revalidatePath(await projectPath("/contacts/campaigns"));
  return { id };
}

export async function startContactCampaign(id: string): Promise<{ queued?: number } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const campaign = await prisma.contactCampaign.findFirst({ where: { id }, select: { channel: true, status: true } });
  if (!campaign) return { error: "That campaign is no longer here." };
  if (campaign.status !== "DRAFT") return { error: "This campaign has already started." };
  const actor = actorOf(granted.session);
  let queued: number | undefined;
  if (campaign.channel === "EMAIL") {
    const ready = await emailChannelReady();
    if (!ready.ready) return { error: ready.reason ?? "Email is not ready." };
    const settings = await prisma.emailSettings.findFirstOrThrow({ select: { settingsVersion: true } });
    const result = await queueCampaignEmails(id, actor, settings.settingsVersion);
    if (!result) return { error: "This campaign has already started." };
    queued = result.queued;
  } else {
    const r = await prisma.contactCampaign.updateMany({ where: { id, status: "DRAFT" }, data: { status: "RUNNING", startedAt: new Date() } });
    if (r.count === 0) return { error: "This campaign has already started." };
  }
  revalidatePath(await projectPath(`/contacts/campaigns/${id}`));
  revalidatePath(await projectPath("/contacts/campaigns"));
  return { queued };
}

export async function finishContactCampaign(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  await prisma.contactCampaign.updateMany({ where: { id, status: { in: ["RUNNING", "DRAFT"] } }, data: { status: "FINISHED", finishedAt: new Date() } });
  revalidatePath(await projectPath(`/contacts/campaigns/${id}`));
  return { ok: true };
}

export async function deleteContactCampaign(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const r = await prisma.contactCampaign.deleteMany({ where: { id, status: "DRAFT" } });
  if (r.count === 0) return { error: "Only a campaign that has not started can be deleted." };
  revalidatePath(await projectPath("/contacts/campaigns"));
  return { ok: true };
}

/** One person on the worklist: done, skipped, or back on the list. */
export async function markCampaignRecipient(recipientId: string, status: "DONE" | "SKIPPED" | "PENDING"): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const row = await prisma.contactCampaignRecipient.findFirst({ where: { id: recipientId }, select: { id: true, campaignId: true, contactId: true, status: true, campaign: { select: { channel: true, status: true, name: true } } } });
  if (!row) return { error: "That person is no longer on this campaign." };
  if (row.campaign.channel === "EMAIL") return { error: "Emails are tracked by the sending service." };
  if (row.campaign.status === "DRAFT") return { error: "Start the campaign first." };
  const now = new Date();
  const actor = actorOf(granted.session);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.contactCampaignRecipient.updateMany({
      where: { id: recipientId, status: status === "PENDING" ? { in: ["DONE", "SKIPPED"] } : "PENDING" },
      data: status === "PENDING" ? { status, doneAt: null, doneById: null, doneByName: null, skipReason: null } : { status, doneAt: now, doneById: actor.userId, doneByName: actor.name, skipReason: status === "SKIPPED" ? "Skipped by a person" : null },
    });
    if (moved.count && status === "DONE") {
      await tx.contact.updateMany({ where: { id: row.contactId }, data: { lastContactedAt: now } });
      await tx.contactEvent.create({ data: eventRow(row.contactId, "CONTACTED", row.campaign.name, actor) });
    }
  });
  revalidatePath(await projectPath(`/contacts/campaigns/${row.campaignId}`));
  return { ok: true };
}

/**
 * Sends one worklist message into a chat this person is already in, through the same path as typing it there: every
 * check the chat makes applies, and a WhatsApp chat that has never written to us is refused. One press, one person.
 */
export async function sendCampaignRecipientInChat(recipientId: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("contacts.campaign", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const row = await prisma.contactCampaignRecipient.findFirst({ where: { id: recipientId }, select: { campaignId: true, status: true, contactId: true, campaign: { select: { status: true, name: true } } } });
  if (!row || row.campaign.status !== "RUNNING") return { error: "That campaign is not running." };
  const claimed = await prisma.contactCampaignRecipient.updateMany({ where: { id: recipientId, status: "PENDING" }, data: { status: "QUEUED" } });
  if (claimed.count === 0) return { error: "Someone has already handled this person." };

  const release = async () => {
    await prisma.contactCampaignRecipient.updateMany({ where: { id: recipientId, status: "QUEUED" }, data: { status: "PENDING" } });
  };
  const detail = await loadCampaign(row.campaignId);
  const recipient = detail?.recipients.find((r) => r.id === recipientId);
  if (!recipient?.inChat) {
    await release();
    return { error: "This person has no chat to send in. Use Open instead." };
  }
  let error: string | null = null;
  if (recipient.inChat.kind === "whatsapp") {
    const form = new FormData();
    form.set("body", recipient.message);
    const result = await sendPersonalChatMessage(recipient.inChat.accountId, recipient.inChat.chatId, {}, form);
    error = result.error ?? null;
  } else {
    const result = await sendChannelReplyAction(recipient.inChat.id, recipient.message, `contact-campaign:${recipientId}`);
    error = "error" in result && result.error ? result.error : null;
  }
  if (error) {
    await release();
    return { error };
  }
  const now = new Date();
  const actor = actorOf(granted.session);
  await prisma.$transaction(async (tx) => {
    await tx.contactCampaignRecipient.updateMany({ where: { id: recipientId, status: "QUEUED" }, data: { status: "DONE", doneAt: now, doneById: actor.userId, doneByName: actor.name } });
    await tx.contact.updateMany({ where: { id: row.contactId }, data: { lastContactedAt: now } });
    await tx.contactEvent.create({ data: eventRow(row.contactId, "CONTACTED", row.campaign.name, actor) });
  });
  revalidatePath(await projectPath(`/contacts/campaigns/${row.campaignId}`));
  return { ok: true };
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

export interface ContactSettingsState {
  error?: string;
  success?: string;
}

export async function saveContactSettings(_prev: ContactSettingsState, form: FormData): Promise<ContactSettingsState> {
  const granted = await checkPermission("settings.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const aiCollectionEnabled = form.get("aiCollectionEnabled") === "on";
  const autoCreateFromChats = form.get("autoCreateFromChats") === "on";
  const current = await prisma.contactSettings.findFirst({ select: { aiCollectionEnabled: true, autoCreateFromChats: true } });
  const wasOn = Boolean(current?.aiCollectionEnabled || current?.autoCreateFromChats);
  const isOn = aiCollectionEnabled || autoCreateFromChats;
  const now = new Date();
  // Switching on starts from this moment: older messages are never read, whatever was switched off in between.
  const start = isOn && !wasOn ? { collectionStartedAt: now, whatsappCursorAt: now, whatsappCursorId: null, channelCursorAt: now } : {};
  await prisma.contactSettings.upsert({
    where: { projectId: await activeProjectId() },
    create: { aiCollectionEnabled, autoCreateFromChats, ...start },
    update: { aiCollectionEnabled, autoCreateFromChats, ...start },
  });
  revalidatePath(await projectPath("/settings/contacts"));
  return { success: "Saved." };
}

/** Pasted text, read on the server as well: the browser's reading is a convenience. */
export async function readPastedContactDetails(text: string) {
  return extractContactIdentifiers(text);
}

/** The one line a person sees when choosing how a campaign will read. */
export async function previewCampaignMessage(body: string): Promise<string> {
  return renderContactCampaignText(body, { name: "Nusrat Jahan", company: "Bizify", serial: 12 });
}
