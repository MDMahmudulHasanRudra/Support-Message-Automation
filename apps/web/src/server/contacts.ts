import { randomUUID } from "node:crypto";
import {
  CAMPAIGN_CHANNEL_KIND,
  channelContactHandleKind,
  channelContactValue,
  channelContactSource,
  collectedChatKind,
  CONTACT_EMAIL_FOOTER,
  contactDisplayName,
  contactIdentifierHref,
  contactMapHref,
  formatContactSerial,
  isContactConsent,
  isContactSource,
  parseContactSerial,
  phoneFromChatId,
  renderContactCampaignText,
  toAsciiDigits,
  type ContactCampaignChannelValue,
  type ContactConsentValue,
  type ContactIdentifierKindValue,
  type ContactImportRow,
  type ContactSourceValue,
  type ConversationRef,
} from "@support-automation/shared";
import { collectContactFromChat, reserveContactSerials, type Prisma } from "@support-automation/db";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import { resolveConversationLinks } from "@/server/followUps";
import type { Session } from "@/server/auth";

/**
 * Contacts (CONTACTS.md): every reading of the list, and the writes more than one action shares. All of it goes through
 * the project-scoped client, so another project's contact is simply not found. One filter builder, `contactWhere`,
 * serves the page, select-all, export and campaigns: they cannot disagree about who is on the list.
 */

export interface ContactActor {
  userId: string | null;
  name: string;
}

export const actorOf = (session: Session): ContactActor => ({ userId: session.userId, name: session.name || session.username });

export function eventRow(contactId: string, kind: string, detail: string | null, actor: ContactActor) {
  return { contactId, kind, detail: detail?.slice(0, 1000) ?? null, actorUserId: actor.userId, actorName: actor.name };
}

// ── The list ────────────────────────────────────────────────────────────────────────────────────

export interface ContactFilters {
  q: string;
  source: ContactSourceValue | null;
  tag: string | null;
  has: "PHONE" | "EMAIL" | "SOCIAL" | "NOTHING" | null;
  consent: ContactConsentValue | null;
  linked: "yes" | "no" | null;
  archived: boolean;
}

const SOCIAL = ["FACEBOOK", "INSTAGRAM", "TELEGRAM", "TIKTOK", "LINKEDIN", "X", "YOUTUBE"] as const;

export function readContactFilters(params: Record<string, unknown>): ContactFilters {
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string).trim() : "");
  const has = str("has");
  const linked = str("linked");
  return {
    q: str("q").slice(0, 120),
    source: isContactSource(str("source")) ? (str("source") as ContactSourceValue) : null,
    tag: str("tag").slice(0, 40) || null,
    has: has === "PHONE" || has === "EMAIL" || has === "SOCIAL" || has === "NOTHING" ? has : null,
    consent: isContactConsent(str("consent")) ? (str("consent") as ContactConsentValue) : null,
    linked: linked === "yes" || linked === "no" ? linked : null,
    // A URL says "1"; "select all that match" sends the filters back as they were read.
    archived: params.archived === true || str("archived") === "1",
  };
}

export function contactWhere(filters: ContactFilters): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [{ status: filters.archived ? "ARCHIVED" : "ACTIVE" }];
  if (filters.source) and.push({ source: filters.source });
  if (filters.tag) and.push({ tags: { has: filters.tag } });
  if (filters.consent) and.push({ consent: filters.consent });
  if (filters.linked) and.push({ linkedClientId: filters.linked === "yes" ? { not: null } : null });
  if (filters.has === "PHONE" || filters.has === "EMAIL") and.push({ identifiers: { some: { kind: filters.has } } });
  if (filters.has === "SOCIAL") and.push({ identifiers: { some: { kind: { in: [...SOCIAL] } } } });
  if (filters.has === "NOTHING") and.push({ identifiers: { none: {} } });
  if (filters.q) {
    const lower = toAsciiDigits(filters.q).toLowerCase();
    const digits = lower.replace(/\D/g, "");
    const serial = parseContactSerial(filters.q);
    const or: Prisma.ContactWhereInput[] = [
      { name: { contains: filters.q, mode: "insensitive" } },
      { company: { contains: filters.q, mode: "insensitive" } },
      { code: { contains: filters.q, mode: "insensitive" } },
      { identifiers: { some: { normalized: { contains: lower.replace(/^@/, "") } } } },
    ];
    if (digits.length >= 4 && digits.length === lower.replace(/[\s+()-]/g, "").length) or.push({ identifiers: { some: { normalized: { contains: digits } } } });
    if (serial !== null) or.push({ serial });
    and.push({ OR: or });
  }
  return { AND: and };
}

export type ContactSelection = { ids: string[] } | { filters: ContactFilters };

export const selectionWhere = (selection: ContactSelection): Prisma.ContactWhereInput => ("ids" in selection ? { id: { in: selection.ids.slice(0, 5000) } } : contactWhere(selection.filters));

export interface ContactListRow {
  id: string;
  label: string;
  code: string | null;
  name: string;
  company: string | null;
  source: ContactSourceValue;
  collectedByAi: boolean;
  tags: string[];
  consent: ContactConsentValue;
  values: Array<{ id: string; kind: ContactIdentifierKindValue; value: string; href: string | null; isWhatsApp: boolean }>;
  chats: number;
  linkedClient: boolean;
  lastContactedAt: string | null;
  createdAt: string;
}

export async function listContacts(filters: ContactFilters, page: number, pageSize: number) {
  const where = contactWhere(filters);
  const [total, rows] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { serial: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, serial: true, code: true, name: true, company: true, source: true, collectedByAi: true, tags: true, consent: true, linkedClientId: true, lastContactedAt: true, createdAt: true,
        identifiers: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, value: true, isWhatsApp: true } },
        _count: { select: { conversations: true } },
      },
    }),
  ]);
  const items: ContactListRow[] = rows.map((c) => ({
    id: c.id,
    label: formatContactSerial(c.serial),
    code: c.code,
    name: contactDisplayName(c),
    company: c.name ? c.company : null,
    source: c.source,
    collectedByAi: c.collectedByAi,
    tags: c.tags,
    consent: c.consent,
    values: c.identifiers.map((i) => ({ id: i.id, kind: i.kind, value: i.value, isWhatsApp: i.isWhatsApp, href: contactIdentifierHref(i.kind, i.value) })),
    chats: c._count.conversations,
    linkedClient: c.linkedClientId !== null,
    lastContactedAt: c.lastContactedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  }));
  return { total, items };
}

export async function loadContactFacets() {
  const projectId = await activeProjectId();
  const [tags, bySource, active, archived, phones, emails, thisWeek] = await Promise.all([
    prisma.$queryRaw<Array<{ tag: string; n: bigint }>>`
      SELECT tag, count(*) AS n FROM "Contact", unnest("tags") AS tag
      WHERE "projectId" = ${projectId} AND "status" = 'ACTIVE'
      GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 60`,
    prisma.contact.groupBy({ by: ["source"], where: { status: "ACTIVE" }, _count: { _all: true } }),
    prisma.contact.count({ where: { status: "ACTIVE" } }),
    prisma.contact.count({ where: { status: "ARCHIVED" } }),
    prisma.contactIdentifier.count({ where: { kind: "PHONE", contact: { status: "ACTIVE" } } }),
    prisma.contactIdentifier.count({ where: { kind: "EMAIL", contact: { status: "ACTIVE" } } }),
    prisma.contact.count({ where: { status: "ACTIVE", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
  ]);
  return {
    tags: tags.map((t) => ({ tag: t.tag, count: Number(t.n) })),
    sources: bySource.map((s) => ({ source: s.source as ContactSourceValue, count: s._count._all })).sort((a, b) => b.count - a.count),
    active,
    archived,
    phones,
    emails,
    thisWeek,
  };
}

// ── One contact ─────────────────────────────────────────────────────────────────────────────────

export async function loadContactProfile(session: Session, id: string) {
  const contact = await prisma.contact.findFirst({
    where: { id },
    include: {
      identifiers: { orderBy: { createdAt: "asc" } },
      conversations: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 60 },
      createdBy: { select: { name: true } },
      recipients: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, status: true, doneAt: true, campaign: { select: { id: true, name: true, channel: true } } } },
    },
  });
  if (!contact) return null;
  const links = contact.conversations.map((c) => ({ accountId: c.accountId, chatId: c.chatId, channelConversationId: c.channelConversationId, clientId: contact.linkedClientId }));
  const resolve = await resolveConversationLinks(session, links.length ? links : [{ accountId: null, chatId: null, channelConversationId: null, clientId: contact.linkedClientId }]);
  const client = resolve({ accountId: null, chatId: null, channelConversationId: null, clientId: contact.linkedClientId }).client;
  return {
    id: contact.id,
    label: formatContactSerial(contact.serial),
    displayName: contactDisplayName(contact),
    code: contact.code,
    name: contact.name,
    company: contact.company,
    jobTitle: contact.jobTitle,
    address: contact.address,
    city: contact.city,
    country: contact.country,
    mapUrl: contact.mapUrl,
    latitude: contact.latitude,
    longitude: contact.longitude,
    mapHref: contactMapHref(contact),
    birthday: contact.birthday,
    notes: contact.notes,
    tags: contact.tags,
    source: contact.source as ContactSourceValue,
    sourceDetail: contact.sourceDetail,
    collectedByAi: contact.collectedByAi,
    status: contact.status,
    consent: contact.consent as ContactConsentValue,
    linkedClientId: contact.linkedClientId,
    client,
    lastContactedAt: contact.lastContactedAt?.toISOString() ?? null,
    createdAt: contact.createdAt.toISOString(),
    createdByName: contact.createdBy?.name ?? null,
    values: contact.identifiers.map((i) => ({
      id: i.id, kind: i.kind as ContactIdentifierKindValue, value: i.value, label: i.label, isWhatsApp: i.isWhatsApp, source: i.source as ContactSourceValue, collectedByAi: i.collectedByAi,
      href: contactIdentifierHref(i.kind, i.value),
    })),
    conversations: contact.conversations.map((c, index) => ({
      id: c.id,
      source: c.source as ContactSourceValue,
      title: c.title,
      open: resolve(links[index]!).conversation,
      createdAt: c.createdAt.toISOString(),
    })),
    events: contact.events.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, actorName: e.actorName, createdAt: e.createdAt.toISOString() })),
    campaigns: contact.recipients.map((r) => ({ id: r.id, status: r.status, doneAt: r.doneAt?.toISOString() ?? null, campaignId: r.campaign.id, campaignName: r.campaign.name, channel: r.campaign.channel })),
  };
}
export type ContactProfile = NonNullable<Awaited<ReturnType<typeof loadContactProfile>>>;

export async function searchContactOptions(q: string, excludeId?: string) {
  const rows = await prisma.contact.findMany({
    where: { AND: [contactWhere({ q, source: null, tag: null, has: null, consent: null, linked: null, archived: false }), excludeId ? { id: { not: excludeId } } : {}] },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { id: true, serial: true, name: true, company: true, identifiers: { take: 2, orderBy: { createdAt: "asc" }, select: { value: true } } },
  });
  return rows.map((r) => ({ id: r.id, label: formatContactSerial(r.serial), name: contactDisplayName(r), detail: r.identifiers.map((i) => i.value).join(" · ") }));
}

// ── Beside a chat ───────────────────────────────────────────────────────────────────────────────

export interface ConversationContact {
  contact: {
    id: string;
    label: string;
    name: string;
    company: string | null;
    notes: string | null;
    tags: string[];
    consent: ContactConsentValue;
    source: ContactSourceValue;
    archived: boolean;
    values: Array<{ id: string; kind: ContactIdentifierKindValue; value: string; href: string | null; isWhatsApp: boolean }>;
  } | null;
  /** What this chat itself tells us, for a chat with no contact yet. */
  suggestion: { name: string | null; values: Array<{ kind: ContactIdentifierKindValue; value: string; normalized: string; isWhatsApp?: boolean }>; isGroup: boolean; handleKind?: ContactIdentifierKindValue };
  canEdit: boolean;
}

/** What a chat can vouch for by itself: its display name and, only where the platform proves it, a number or handle. */
export async function conversationFacts(ref: ConversationRef) {
  if (ref.kind === "whatsapp") {
    const isGroup = collectedChatKind(ref.chatId) === "GROUP";
    const phone = isGroup ? null : phoneFromChatId(ref.chatId);
    let name: string | null = null;
    if (isGroup) {
      name = (await prisma.whatsAppGroup.findFirst({ where: { accountId: ref.accountId, whatsappGroupId: ref.chatId }, select: { name: true } }))?.name ?? null;
    } else {
      const latest = await prisma.message.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId, groupId: null, direction: "INCOMING", senderName: { not: null } }, orderBy: { timestampWa: "desc" }, select: { senderName: true } });
      name = latest?.senderName?.trim() || null;
    }
    return {
      source: "WHATSAPP" as ContactSourceValue,
      isGroup,
      name,
      title: name,
      chat: { accountId: ref.accountId, chatId: ref.chatId } as const,
      values: phone ? [{ ...phone, isWhatsApp: true }] : [],
      handleKind: undefined,
    };
  }
  const conversation = await prisma.channelConversation.findFirst({ where: { id: ref.conversationId }, select: { type: true, title: true, customerName: true, customerUsername: true } });
  const source = channelContactSource(conversation?.type ?? "");
  const value = channelContactValue(conversation?.type ?? "", conversation?.customerUsername);
  const kind = channelContactHandleKind(conversation?.type ?? "");
  return {
    source,
    isGroup: false,
    name: conversation?.customerName?.trim() || null,
    title: conversation?.customerName?.trim() || conversation?.title || null,
    chat: { channelConversationId: ref.conversationId } as const,
    values: value ? [{ ...value, isWhatsApp: value.kind === "PHONE" }] : [],
    handleKind: kind ?? undefined,
  };
}

export async function loadConversationContact(session: Session, ref: ConversationRef): Promise<ConversationContact | null> {
  const disabled = await activeDisabledFeatures();
  if (disabled.has("CONTACTS") || !(await hasPermission(session, "contacts.view"))) return null;
  const [canEdit, facts, link] = await Promise.all([
    hasPermission(session, "contacts.edit"),
    conversationFacts(ref),
    prisma.contactConversationLink.findFirst({
      where: ref.kind === "whatsapp" ? { chatId: ref.chatId } : { channelConversationId: ref.conversationId },
      select: {
        contact: {
          select: {
            id: true, serial: true, name: true, company: true, notes: true, tags: true, consent: true, source: true, status: true,
            identifiers: { orderBy: { createdAt: "asc" }, select: { id: true, kind: true, value: true, isWhatsApp: true } },
          },
        },
      },
    }),
  ]);
  const c = link?.contact;
  return {
    canEdit,
    suggestion: { name: facts.name, values: facts.values, isGroup: facts.isGroup, handleKind: facts.handleKind },
    contact: c
      ? {
          id: c.id, label: formatContactSerial(c.serial), name: contactDisplayName(c), company: c.name ? c.company : null, notes: c.notes, tags: c.tags, consent: c.consent as ContactConsentValue, source: c.source as ContactSourceValue, archived: c.status === "ARCHIVED",
          values: c.identifiers.map((i) => ({ id: i.id, kind: i.kind as ContactIdentifierKindValue, value: i.value, isWhatsApp: i.isWhatsApp, href: contactIdentifierHref(i.kind, i.value) })),
        }
      : null,
  };
}

export async function collectFromConversation(session: Session, ref: ConversationRef, input: { name: string | null; values: Array<{ kind: ContactIdentifierKindValue; value: string; normalized: string; isWhatsApp?: boolean }> }) {
  const facts = await conversationFacts(ref);
  const projectId = await activeProjectId();
  const actor = actorOf(session);
  return collectContactFromChat(prisma, {
    projectId,
    chat: facts.chat,
    chatTitle: facts.title,
    source: facts.source,
    sourceDetail: facts.title ? `From the chat with ${facts.title}` : "From a chat",
    name: input.name ?? facts.name,
    values: [...facts.values, ...input.values],
    collectedByAi: false,
    actor,
  });
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

export interface ContactImportResult {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  problems: Array<{ line: number; text: string }>;
}

const CHUNK = 200;

/**
 * Rows into contacts. A row whose number, address or code is already known ADDS what is missing to that contact and fills
 * only its empty fields, so an import can be run twice and changes nothing the second time. Runs in chunks; each chunk is
 * one transaction, so a failure leaves whole rows, never half a contact.
 */
export async function saveContactImportRows(rows: readonly ContactImportRow[], ctx: { source: ContactSourceValue; sourceDetail: string; actor: ContactActor; clientIdOf?: (row: ContactImportRow) => string | null }): Promise<ContactImportResult> {
  const projectId = await activeProjectId();
  const result: ContactImportResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, problems: [] };
  for (const row of rows) for (const text of row.problems.slice(0, 2)) if (result.problems.length < 200) result.problems.push({ line: row.line, text });
  const usable = rows.filter((r) => r.fields.name || r.fields.company || r.identifiers.length);
  result.skipped = rows.length - usable.length;

  for (let i = 0; i < usable.length; i += CHUNK) {
    const chunk = usable.slice(i, i + CHUNK);
    await prisma.$transaction(
      async (tx) => {
        const values = chunk.flatMap((r) => r.identifiers);
        const codes = chunk.flatMap((r) => (r.fields.code ? [r.fields.code] : []));
        const [known, knownCodes] = await Promise.all([
          values.length ? tx.contactIdentifier.findMany({ where: { OR: values.map((v) => ({ kind: v.kind, normalized: v.normalized })) }, select: { kind: true, normalized: true, contactId: true } }) : [],
          codes.length ? tx.contact.findMany({ where: { code: { in: codes, mode: "insensitive" } }, select: { id: true, code: true } }) : [],
        ]);
        const holder = new Map(known.map((k) => [`${k.kind}:${k.normalized}`, k.contactId]));
        const codeHolder = new Map(knownCodes.map((c) => [c.code!.toLowerCase(), c.id]));

        // Rows of this chunk that share a value become one contact.
        const fresh = chunk.filter((r) => !r.identifiers.some((v) => holder.has(`${v.kind}:${v.normalized}`)) && !(r.fields.code && codeHolder.has(r.fields.code.toLowerCase())));
        const newRows: ContactImportRow[] = [];
        const tempByValue = new Map<string, number>();
        const mergedInto = new Map<ContactImportRow, number>();
        for (const row of fresh) {
          const twin = row.identifiers.map((v) => tempByValue.get(`${v.kind}:${v.normalized}`)).find((n) => n !== undefined);
          const index = twin ?? newRows.length;
          if (twin === undefined) newRows.push(row);
          else mergedInto.set(row, twin);
          for (const v of row.identifiers) tempByValue.set(`${v.kind}:${v.normalized}`, index);
        }

        const ids = newRows.map(() => randomUUID());
        if (newRows.length) {
          const first = await reserveContactSerials(tx, projectId, newRows.length);
          await tx.contact.createMany({
            data: newRows.map((row, n) => {
              const f = row.fields;
              return {
                id: ids[n]!, serial: first + n, code: f.code, name: f.name, company: f.company, jobTitle: f.jobTitle, address: f.address, city: f.city, country: f.country, mapUrl: f.mapUrl,
                latitude: f.latitude, longitude: f.longitude, birthday: f.birthday, notes: f.notes, tags: f.tags, source: ctx.source, sourceDetail: ctx.sourceDetail, consent: row.consent ?? "UNKNOWN",
                createdById: ctx.actor.userId, linkedClientId: ctx.clientIdOf?.(row) ?? null,
              };
            }),
            skipDuplicates: true,
          });
          await tx.contactEvent.createMany({ data: ids.map((id) => eventRow(id, "IMPORTED", ctx.sourceDetail, ctx.actor)) });
          result.created += newRows.length;
        }

        const targetOf = (row: ContactImportRow): { id: string; existing: boolean } | null => {
          const via = row.identifiers.map((v) => holder.get(`${v.kind}:${v.normalized}`)).find(Boolean) ?? (row.fields.code ? codeHolder.get(row.fields.code.toLowerCase()) : undefined);
          if (via) return { id: via, existing: true };
          const n = mergedInto.get(row) ?? newRows.indexOf(row);
          return n >= 0 ? { id: ids[n]!, existing: false } : null;
        };

        const adds: Array<{ contactId: string; kind: ContactIdentifierKindValue; value: string; normalized: string; isWhatsApp: boolean; source: ContactSourceValue }> = [];
        const seen = new Set(holder.keys());
        const addedTo = new Set<string>();
        for (const row of chunk) {
          const target = targetOf(row);
          if (!target) continue;
          for (const v of row.identifiers) {
            const key = `${v.kind}:${v.normalized}`;
            if (seen.has(key)) continue;
            seen.add(key);
            adds.push({ contactId: target.id, kind: v.kind, value: v.value, normalized: v.normalized, isWhatsApp: v.isWhatsApp, source: ctx.source });
            if (target.existing) addedTo.add(target.id);
          }
        }
        if (adds.length) await tx.contactIdentifier.createMany({ data: adds, skipDuplicates: true });

        // An existing contact only has its blanks filled.
        const existing = chunk.flatMap((row) => {
          const target = targetOf(row);
          return target?.existing ? [{ row, id: target.id }] : [];
        });
        if (existing.length) {
          const current = await tx.contact.findMany({ where: { id: { in: existing.map((e) => e.id) } }, select: { id: true, name: true, company: true, jobTitle: true, address: true, city: true, country: true, mapUrl: true, latitude: true, longitude: true, birthday: true, notes: true, tags: true, code: true, linkedClientId: true } });
          const byId = new Map(current.map((c) => [c.id, c]));
          const filled = new Set<string>();
          for (const { row, id } of existing) {
            const c = byId.get(id);
            if (!c) continue;
            const f = row.fields;
            const data: Prisma.ContactUpdateManyMutationInput & { linkedClientId?: string } = {};
            for (const key of ["name", "company", "jobTitle", "address", "city", "country", "birthday", "notes"] as const) if (f[key] && !c[key]) data[key] = f[key];
            if (f.mapUrl && !c.mapUrl) data.mapUrl = f.mapUrl;
            if (f.latitude !== null && c.latitude === null) Object.assign(data, { latitude: f.latitude, longitude: f.longitude });
            const missing = f.tags.filter((t) => !c.tags.some((have) => have.toLowerCase() === t.toLowerCase()));
            if (missing.length) data.tags = [...c.tags, ...missing].slice(0, 20);
            const clientId = ctx.clientIdOf?.(row);
            if (clientId && !c.linkedClientId) data.linkedClientId = clientId;
            if (Object.keys(data).length) {
              await tx.contact.updateMany({ where: { id }, data });
              Object.assign(c, data);
              filled.add(id);
            }
          }
          const touched = new Set([...addedTo, ...filled]);
          if (touched.size) await tx.contactEvent.createMany({ data: [...touched].map((id) => eventRow(id, "IMPORTED", `Updated from ${ctx.sourceDetail}`, ctx.actor)) });
          result.updated += touched.size;
          result.unchanged += new Set(existing.map((e) => e.id)).size - touched.size;
        }
      },
      { timeout: 60_000 },
    );
  }
  return result;
}

// ── Campaigns ───────────────────────────────────────────────────────────────────────────────────

const CHANNEL_CHAT_SOURCE: Partial<Record<ContactCampaignChannelValue, ContactSourceValue>> = { WHATSAPP: "WHATSAPP", MESSENGER: "MESSENGER", INSTAGRAM: "INSTAGRAM", TELEGRAM: "TELEGRAM" };

export interface CampaignAudienceRow {
  contactId: string;
  toValue: string | null;
  skipReason: string | null;
}

/** Who a campaign would reach, and why anyone else would not. Someone who said no to offers is never included, whatever is ticked. */
export async function readCampaignAudience(selection: ContactSelection, channel: ContactCampaignChannelValue, includeUnknownConsent: boolean): Promise<CampaignAudienceRow[]> {
  const kind = CAMPAIGN_CHANNEL_KIND[channel];
  const chatSource = CHANNEL_CHAT_SOURCE[channel];
  const contacts = await prisma.contact.findMany({
    where: { AND: [selectionWhere(selection), { status: "ACTIVE" }] },
    take: 5001,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      consent: true,
      identifiers: { where: { kind }, orderBy: { createdAt: "asc" }, select: { value: true, isWhatsApp: true } },
      conversations: chatSource ? { where: { source: chatSource }, take: 1, select: { id: true } } : false,
    },
  });
  return contacts.map((c) => {
    const preferred = channel === "WHATSAPP" ? (c.identifiers.find((i) => i.isWhatsApp) ?? c.identifiers[0]) : c.identifiers[0];
    const hasChat = Boolean(chatSource && (c.conversations as Array<{ id: string }> | undefined)?.length);
    let skipReason: string | null = null;
    if (c.consent === "OPTED_OUT") skipReason = "Said no to offers";
    else if (c.consent === "UNKNOWN" && !includeUnknownConsent) skipReason = "Has not agreed to offers";
    else if (!preferred && !hasChat) skipReason = `No ${kind === "PHONE" ? "phone number" : kind === "EMAIL" ? "email address" : "account"} on file`;
    return { contactId: c.id, toValue: preferred?.value ?? null, skipReason };
  });
}

export function summariseAudience(rows: readonly CampaignAudienceRow[]) {
  const reasons = new Map<string, number>();
  for (const r of rows) if (r.skipReason) reasons.set(r.skipReason, (reasons.get(r.skipReason) ?? 0) + 1);
  return { reachable: rows.filter((r) => !r.skipReason).length, total: rows.length, skipped: [...reasons].map(([reason, count]) => ({ reason, count })) };
}

export async function listCampaigns() {
  const [campaigns, counts] = await Promise.all([
    prisma.contactCampaign.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.contactCampaignRecipient.groupBy({ by: ["campaignId", "status"], _count: { _all: true } }),
  ]);
  const byCampaign = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const row = byCampaign.get(c.campaignId) ?? {};
    row[c.status] = c._count._all;
    byCampaign.set(c.campaignId, row);
  }
  return campaigns.map((c) => {
    const n = byCampaign.get(c.id) ?? {};
    return { id: c.id, name: c.name, channel: c.channel as ContactCampaignChannelValue, status: settledStatus(c.status, n), createdAt: c.createdAt.toISOString(), createdByName: c.createdByName, pending: (n.PENDING ?? 0) + (n.QUEUED ?? 0), done: n.DONE ?? 0, skipped: n.SKIPPED ?? 0 };
  });
}

/** A running campaign with nobody left to reach reads as finished. */
function settledStatus(status: "DRAFT" | "RUNNING" | "FINISHED", n: Record<string, number>): "DRAFT" | "RUNNING" | "FINISHED" {
  return status === "RUNNING" && !(n.PENDING ?? 0) && !(n.QUEUED ?? 0) ? "FINISHED" : status;
}

export async function loadCampaign(id: string) {
  const campaign = await prisma.contactCampaign.findFirst({ where: { id } });
  if (!campaign) return null;
  const channel = campaign.channel as ContactCampaignChannelValue;
  const chatSource = CHANNEL_CHAT_SOURCE[channel];
  const [counts, rows] = await Promise.all([
    prisma.contactCampaignRecipient.groupBy({ by: ["status"], where: { campaignId: id }, _count: { _all: true } }),
    prisma.contactCampaignRecipient.findMany({
      where: { campaignId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1000,
      select: {
        id: true, status: true, toValue: true, skipReason: true, doneByName: true, doneAt: true,
        emailOutbox: { select: { status: true, lastError: true } },
        contact: {
          select: {
            id: true, serial: true, name: true, company: true,
            conversations: chatSource ? { where: { source: chatSource }, take: 1, orderBy: { createdAt: "desc" }, select: { accountId: true, chatId: true, channelConversationId: true } } : false,
          },
        },
      },
    }),
  ]);
  const n: Record<string, number> = {};
  for (const c of counts) n[c.status] = c._count._all;
  return {
    id: campaign.id,
    name: campaign.name,
    channel,
    status: settledStatus(campaign.status, n),
    subject: campaign.subject,
    body: campaign.body,
    createdAt: campaign.createdAt.toISOString(),
    createdByName: campaign.createdByName,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    counts: { pending: n.PENDING ?? 0, queued: n.QUEUED ?? 0, done: n.DONE ?? 0, skipped: n.SKIPPED ?? 0 },
    recipients: rows.map((r) => {
      const chat = (r.contact.conversations as Array<{ accountId: string | null; chatId: string | null; channelConversationId: string | null }> | undefined)?.[0];
      const inChat = chat?.channelConversationId ? { kind: "channel" as const, id: chat.channelConversationId } : chat?.chatId && chat.accountId && collectedChatKind(chat.chatId) === "PERSONAL" ? { kind: "whatsapp" as const, accountId: chat.accountId, chatId: chat.chatId } : null;
      return {
        id: r.id,
        status: r.status,
        toValue: r.toValue,
        skipReason: r.skipReason,
        doneByName: r.doneByName,
        doneAt: r.doneAt?.toISOString() ?? null,
        emailStatus: r.emailOutbox?.status ?? null,
        contactId: r.contact.id,
        contactLabel: formatContactSerial(r.contact.serial),
        contactName: contactDisplayName(r.contact),
        message: renderContactCampaignText(campaign.body, r.contact),
        inChat,
      };
    }),
  };
}
export type CampaignDetail = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

/** One email row per person still waiting, in one transaction with the campaign's move to RUNNING. */
export async function queueCampaignEmails(campaignId: string, actor: ContactActor, settingsVersion: number): Promise<{ queued: number } | null> {
  const projectId = await activeProjectId();
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.contactCampaign.updateMany({ where: { id: campaignId, status: "DRAFT", channel: "EMAIL" }, data: { status: "RUNNING", startedAt: new Date() } });
      if (claimed.count === 0) return null;
      const campaign = await tx.contactCampaign.findFirstOrThrow({ where: { id: campaignId }, select: { subject: true, body: true } });
      const recipients = await tx.contactCampaignRecipient.findMany({
        where: { campaignId, status: "PENDING", toValue: { not: null }, contact: { status: "ACTIVE", consent: { not: "OPTED_OUT" } } },
        select: { contactId: true, toValue: true, contact: { select: { name: true, company: true, serial: true } } },
      });
      for (let i = 0; i < recipients.length; i += 500) {
        await tx.emailOutbox.createMany({
          data: recipients.slice(i, i + 500).map((r) => ({
            purpose: "CONTACT_CAMPAIGN" as const,
            toAddress: r.toValue!,
            subject: renderContactCampaignText(campaign.subject ?? "", r.contact),
            bodyText: renderContactCampaignText(campaign.body, r.contact) + CONTACT_EMAIL_FOOTER,
            idempotencyKey: `contact-campaign:${campaignId}:${r.contactId}`,
            settingsVersion,
            createdById: actor.userId,
            nextAttemptAt: new Date(),
          })),
          skipDuplicates: true,
        });
      }
      await tx.$executeRaw`
        UPDATE "ContactCampaignRecipient" r SET "emailOutboxId" = e."id", "status" = 'QUEUED'
        FROM "EmailOutbox" e
        WHERE r."projectId" = ${projectId} AND e."projectId" = ${projectId} AND r."campaignId" = ${campaignId} AND r."status" = 'PENDING'
          AND e."idempotencyKey" = 'contact-campaign:' || r."campaignId" || ':' || r."contactId"`;
      await tx.contactCampaignRecipient.updateMany({ where: { campaignId, status: "PENDING" }, data: { status: "SKIPPED", skipReason: "No longer reachable when the campaign started" } });
      return { queued: recipients.length };
    },
    { timeout: 60_000 },
  );
}
