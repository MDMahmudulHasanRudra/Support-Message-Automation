"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  CLIENT_CHANNEL_KINDS,
  CLIENT_LIMITS,
  isClientConsent,
  isClientStatus,
  normalizeChannelDrafts,
  normalizeTags,
  validateClientFields,
  type ClientChannelDraft,
  type ClientConsentValue,
  type ClientStatusValue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { buildClientWhere, clientOrderBy, MAX_CLIENT_BULK, parseClientFilters } from "@/lib/clientFilters";
import {
  channelFields,
  findDuplicateClients,
  nextClientCode,
  recordClientActivity,
  type DuplicateClient,
} from "@/server/clientRecords";

/**
 * Client Management actions. Every one is a public endpoint, so every one makes its own permission
 * check (the page that shows its button proves nothing). Nothing here sends a message to a client,
 * and nothing touches billing: a client record is contact data, channel references, notes and a
 * timeline.
 */

export interface ClientFormState {
  error?: string;
  success?: boolean;
  clientId?: string;
  /** Existing clients that share an identifier with what was entered. Shown before anything is created. */
  duplicates?: DuplicateClient[];
  /**
   * What was typed, returned with a refusal. React clears an uncontrolled form after EVERY action that
   * returns, refusals included, so without this a refused submission (or "Create anyway" after a
   * duplicate warning) would arrive with every field empty.
   */
  values?: Record<string, string>;
}

export interface BulkClientResult {
  ok: boolean;
  message: string;
}

const ARCHIVED_ERROR = "This client is archived. Restore it before changing it.";

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** The text fields of a submission, for sending back with a refusal. Never the confirmation flag. */
function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && key !== "confirmDuplicate" && !key.startsWith("$ACTION")) out[key] = value.slice(0, 4000);
  }
  return out;
}

async function refresh(clientId?: string) {
  revalidatePath(await projectPath("/clients"));
  if (clientId) revalidatePath(await projectPath(`/clients/${clientId}`));
}

/** The staff member / team the form named, each checked to exist in THIS project. Null = nobody. */
async function resolveAssignee(formData: FormData): Promise<{ memberId: string | null; teamId: string | null } | { error: string }> {
  const memberId = text(formData, "assignedMemberId") || null;
  const teamId = text(formData, "assignedTeamId") || null;
  if (memberId && !(await prisma.internalTeamMember.findFirst({ where: { id: memberId }, select: { id: true } }))) {
    return { error: "That staff member does not exist in this project." };
  }
  if (teamId && !(await prisma.team.findFirst({ where: { id: teamId }, select: { id: true } }))) {
    return { error: "That team does not exist in this project." };
  }
  return { memberId, teamId };
}

function readClientForm(formData: FormData) {
  return validateClientFields({
    name: text(formData, "name"),
    code: text(formData, "code"),
    companyName: text(formData, "companyName"),
    status: text(formData, "status") || undefined,
    category: text(formData, "category"),
    preferredChannel: text(formData, "preferredChannel"),
    preferredLanguage: text(formData, "preferredLanguage"),
    address: text(formData, "address"),
    businessDetails: text(formData, "businessDetails"),
    followUpInstructions: text(formData, "followUpInstructions"),
    tags: text(formData, "tags"),
  });
}

export async function createClient(_prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.create");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };

  const parsed = readClientForm(formData);
  if (!parsed.value) return { error: parsed.errors.join(" "), values: echo(formData) };
  if (parsed.value.status === "ARCHIVED") return { error: "A new client cannot start archived.", values: echo(formData) };

  const drafts: ClientChannelDraft[] = [];
  const phone = text(formData, "phone");
  const whatsapp = text(formData, "whatsapp");
  const email = text(formData, "email");
  if (phone) drafts.push({ kind: "PHONE", value: phone, isPrimary: true });
  if (whatsapp) drafts.push({ kind: "WHATSAPP", value: whatsapp, isPrimary: true });
  if (email) drafts.push({ kind: "EMAIL", value: email, isPrimary: true });
  const channels = normalizeChannelDrafts(drafts);
  if (channels.errors.length) return { error: channels.errors.join(" "), values: echo(formData) };

  const assignee = await resolveAssignee(formData);
  if ("error" in assignee) return { error: assignee.error, values: echo(formData) };

  const duplicates = await findDuplicateClients({ channels: channels.channels, code: parsed.value.code });
  if (duplicates.length && formData.get("confirmDuplicate") !== "1") {
    return { error: "This looks like a client you already have. Check the matches below, or create it anyway.", duplicates, values: echo(formData) };
  }

  const fields = parsed.value;
  try {
    const clientId = await prisma.$transaction(async (tx) => {
      const code = fields.code ?? (await nextClientCode(tx));
      const created = await tx.client.create({
        data: {
          code,
          name: fields.name,
          companyName: fields.companyName,
          status: fields.status,
          category: fields.category,
          preferredChannel: fields.preferredChannel,
          preferredLanguage: fields.preferredLanguage,
          address: fields.address,
          businessDetails: fields.businessDetails,
          followUpInstructions: fields.followUpInstructions,
          tags: fields.tags,
          customFields: fields.customFields,
          source: "MANUAL",
          assignedMemberId: assignee.memberId,
          assignedTeamId: assignee.teamId,
          createdById: granted.session.userId,
          channels: { create: channels.channels.map((c) => channelFields(c, "recorded by staff")) },
        },
        select: { id: true },
      });
      await recordClientActivity(tx, created.id, granted.session.userId, { type: "CREATED", summary: `Client ${code} created by staff` });
      return created.id;
    });
    await refresh();
    return { success: true, clientId };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "That client code is already used by another client.", values: echo(formData) };
    throw err;
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  companyName: "company",
  category: "category",
  preferredChannel: "preferred channel",
  preferredLanguage: "preferred language",
  address: "address",
  businessDetails: "business details",
  followUpInstructions: "follow-up instructions",
  code: "client code",
};

export async function updateClient(clientId: string, _prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };

  const current = await prisma.client.findFirst({ where: { id: clientId } });
  if (!current) return { error: "That client no longer exists.", values: echo(formData) };

  const parsed = readClientForm(formData);
  if (!parsed.value) return { error: parsed.errors.join(" "), values: echo(formData) };
  const fields = parsed.value;
  if (fields.status === "ARCHIVED" && current.status !== "ARCHIVED") return { error: "Use Archive to archive a client.", values: echo(formData) };
  if (current.status === "ARCHIVED" && fields.status !== "ARCHIVED") return { error: "Restore this client before editing it.", values: echo(formData) };
  const assignee = await resolveAssignee(formData);
  if ("error" in assignee) return { error: assignee.error, values: echo(formData) };

  const code = fields.code ?? current.code; // clearing the code keeps the old one: a client always has one
  const next = {
    name: fields.name,
    companyName: fields.companyName,
    category: fields.category,
    preferredChannel: fields.preferredChannel,
    preferredLanguage: fields.preferredLanguage,
    address: fields.address,
    businessDetails: fields.businessDetails,
    followUpInstructions: fields.followUpInstructions,
    code,
  };
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => (current[k] ?? null) !== (next[k] ?? null));
  const tagsChanged = [...current.tags].sort().join("|") !== [...fields.tags].sort().join("|");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.client.update({
        where: { id: clientId },
        data: {
          ...next,
          status: fields.status,
          tags: fields.tags,
          customFields: Object.keys(fields.customFields).length ? fields.customFields : (current.customFields as Prisma.InputJsonValue),
          assignedMemberId: assignee.memberId,
          assignedTeamId: assignee.teamId,
        },
      });
      if (changed.length) {
        await recordClientActivity(tx, clientId, granted.session.userId, {
          type: "UPDATED",
          summary: `Updated ${changed.map((k) => FIELD_LABELS[k] ?? k).join(", ")}`,
        });
      }
      if (fields.status !== current.status) {
        await recordClientActivity(tx, clientId, granted.session.userId, {
          type: "STATUS_CHANGED",
          summary: `Status changed from ${current.status} to ${fields.status}`,
          details: { from: current.status, to: fields.status },
        });
      }
      if (assignee.memberId !== current.assignedMemberId || assignee.teamId !== current.assignedTeamId) {
        await recordClientActivity(tx, clientId, granted.session.userId, { type: "ASSIGNED", summary: "Assignment changed" });
      }
      if (tagsChanged) {
        await recordClientActivity(tx, clientId, granted.session.userId, { type: "TAGS_CHANGED", summary: "Tags changed", details: { tags: fields.tags } });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "That client code is already used by another client.", values: echo(formData) };
    throw err;
  }
  await refresh(clientId);
  return { success: true, clientId };
}

// ── Notes and channels ──────────────────────────────────────────────────────────────────────────

export async function addClientNote(clientId: string, _prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };
  const body = text(formData, "body");
  if (!body) return { error: "Write the note first.", values: echo(formData) };
  if (body.length > CLIENT_LIMITS.note) return { error: `A note can be at most ${CLIENT_LIMITS.note} characters.`, values: echo(formData) };
  const noteClient = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!noteClient) return { error: "That client no longer exists.", values: echo(formData) };
  if (noteClient.status === "ARCHIVED") return { error: ARCHIVED_ERROR, values: echo(formData) };
  await prisma.$transaction(async (tx) => {
    await tx.clientNote.create({ data: { clientId, body, authorId: granted.session.userId } });
    // The timeline says a note was added, not what it said: notes are internal and the timeline is wider-read.
    await recordClientActivity(tx, clientId, granted.session.userId, { type: "NOTE_ADDED", summary: "Internal note added" });
  });
  await refresh(clientId);
  return { success: true, clientId };
}

export async function addClientChannel(clientId: string, _prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };
  const kind = text(formData, "kind");
  if (!(CLIENT_CHANNEL_KINDS as readonly string[]).includes(kind)) return { error: "Choose what kind of channel this is.", values: echo(formData) };
  const client = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!client) return { error: "That client no longer exists.", values: echo(formData) };
  if (client.status === "ARCHIVED") return { error: ARCHIVED_ERROR, values: echo(formData) };

  if (kind === "WHATSAPP_GROUP" && !(await prisma.whatsAppGroup.findFirst({ where: { whatsappGroupId: text(formData, "value") }, select: { id: true } }))) {
    return { error: "That WhatsApp group is not one of this project's groups.", values: echo(formData) };
  }
  const normalized = normalizeChannelDrafts([{ kind: kind as ClientChannelDraft["kind"], value: text(formData, "value"), label: text(formData, "label"), isPrimary: formData.get("isPrimary") === "on" }]);
  if (normalized.errors.length || !normalized.channels[0]) return { error: normalized.errors.join(" ") || "Enter the reference.", values: echo(formData) };
  const channel = normalized.channels[0];

  const existingCount = await prisma.clientChannel.count({ where: { clientId } });
  if (existingCount >= CLIENT_LIMITS.channels) return { error: `A client can have at most ${CLIENT_LIMITS.channels} channel references.`, values: echo(formData) };
  const duplicates = await findDuplicateClients({ channels: [channel], excludeClientId: clientId });
  if (duplicates.length && formData.get("confirmDuplicate") !== "1") {
    return { error: "Another client already has this reference. Check it below, or add it anyway.", duplicates, values: echo(formData) };
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (channel.isPrimary) await tx.clientChannel.updateMany({ where: { clientId, kind: channel.kind, isPrimary: true }, data: { isPrimary: false } });
      await tx.clientChannel.create({ data: { clientId, ...channelFields(channel, "recorded by staff") } });
      await recordClientActivity(tx, clientId, granted.session.userId, { type: "CHANNEL_ADDED", summary: `Added ${channel.kind.toLowerCase().replace("_", " ")} reference` });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "This client already has that reference.", values: echo(formData) };
    throw err;
  }
  await refresh(clientId);
  return { success: true, clientId };
}

export async function removeClientChannel(channelId: string): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const channel = await prisma.clientChannel.findFirst({ where: { id: channelId }, select: { id: true, clientId: true, kind: true, client: { select: { status: true } } } });
  if (!channel) return { ok: false, message: "That reference no longer exists." };
  if (channel.client.status === "ARCHIVED") return { ok: false, message: ARCHIVED_ERROR };
  await prisma.$transaction(async (tx) => {
    await tx.clientChannel.delete({ where: { id: channel.id } });
    await recordClientActivity(tx, channel.clientId, granted.session.userId, { type: "CHANNEL_REMOVED", summary: `Removed ${channel.kind.toLowerCase().replace("_", " ")} reference` });
  });
  await refresh(channel.clientId);
  return { ok: true, message: "Reference removed." };
}

/** Records what a client has said about being contacted on ONE channel. It sends nothing and changes no other channel. */
export async function setClientChannelConsent(channelId: string, status: string, note?: string): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  if (!isClientConsent(status)) return { ok: false, message: "That consent value is not recognised." };
  const channel = await prisma.clientChannel.findFirst({ where: { id: channelId }, select: { id: true, clientId: true, kind: true, consentStatus: true, client: { select: { status: true } } } });
  if (!channel) return { ok: false, message: "That reference no longer exists." };
  if (channel.client.status === "ARCHIVED") return { ok: false, message: ARCHIVED_ERROR };
  if (channel.consentStatus === status) return { ok: true, message: "Nothing changed." };
  await prisma.$transaction(async (tx) => {
    await tx.clientChannel.update({
      where: { id: channel.id },
      data: { consentStatus: status as ClientConsentValue, consentChangedAt: new Date(), consentSource: "recorded by staff", consentNote: note?.trim().slice(0, 300) || null },
    });
    await recordClientActivity(tx, channel.clientId, granted.session.userId, {
      type: "CONSENT_CHANGED",
      summary: `${channel.kind.toLowerCase().replace("_", " ")} consent: ${channel.consentStatus} → ${status}`,
      details: { channelId: channel.id, from: channel.consentStatus, to: status },
    });
  });
  await refresh(channel.clientId);
  return { ok: true, message: "Consent recorded." };
}

// ── Bulk actions ────────────────────────────────────────────────────────────────────────────────

function cleanIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids)) return null;
  const out = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 64))];
  return out.length && out.length <= MAX_CLIENT_BULK ? out : null;
}

const TOO_MANY = `Choose between 1 and ${MAX_CLIENT_BULK.toLocaleString()} clients.`;

/** Every client id matching these URL filters (the same builder as the page), capped. */
export async function selectAllMatchingClientIds(params: Record<string, string>): Promise<{ ids: string[]; truncated: boolean }> {
  const granted = await checkPermission("clients.view");
  if ("denied" in granted) return { ids: [], truncated: false };
  const filters = parseClientFilters(params ?? {});
  const rows = await prisma.client.findMany({ where: buildClientWhere(filters), select: { id: true }, orderBy: clientOrderBy("name", "asc"), take: MAX_CLIENT_BULK + 1 });
  return { ids: rows.slice(0, MAX_CLIENT_BULK).map((r) => r.id), truncated: rows.length > MAX_CLIENT_BULK };
}

export async function archiveClients(ids: string[]): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.archive");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: { not: "ARCHIVED" } }, select: { id: true, status: true } });
  if (!rows.length) return { ok: true, message: "Nothing to archive — those clients are already archived or no longer exist." };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.client.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "ARCHIVED", archivedAt: now } });
    await tx.clientActivity.createMany({
      data: rows.map((r) => ({ clientId: r.id, actorUserId: granted.session.userId, type: "ARCHIVED", summary: "Client archived", details: { previousStatus: r.status } })),
    });
  });
  await refresh();
  const skipped = clean.length - rows.length;
  return { ok: true, message: `${rows.length} archived${skipped ? `, ${skipped} already archived or missing` : ""}. Nothing was deleted; restore them any time.` };
}

export async function restoreClients(ids: string[]): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.archive");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: "ARCHIVED" }, select: { id: true } });
  if (!rows.length) return { ok: true, message: "Nothing to restore — none of those clients is archived." };
  // Back to the status each had when it was archived (the timeline remembers it), ACTIVE when unknown.
  const archivedEntries = await prisma.clientActivity.findMany({
    where: { clientId: { in: rows.map((r) => r.id) }, type: "ARCHIVED" },
    orderBy: { createdAt: "desc" },
    select: { clientId: true, details: true },
  });
  const previous = new Map<string, ClientStatusValue>();
  for (const entry of archivedEntries) {
    if (previous.has(entry.clientId)) continue;
    const status = (entry.details as { previousStatus?: unknown } | null)?.previousStatus;
    if (isClientStatus(status) && status !== "ARCHIVED") previous.set(entry.clientId, status);
  }
  const byStatus = new Map<ClientStatusValue, string[]>();
  for (const r of rows) {
    const status = previous.get(r.id) ?? "ACTIVE";
    byStatus.set(status, [...(byStatus.get(status) ?? []), r.id]);
  }
  await prisma.$transaction(async (tx) => {
    for (const [status, group] of byStatus) await tx.client.updateMany({ where: { id: { in: group } }, data: { status, archivedAt: null } });
    await tx.clientActivity.createMany({ data: rows.map((r) => ({ clientId: r.id, actorUserId: granted.session.userId, type: "RESTORED", summary: "Client restored" })) });
  });
  await refresh();
  return { ok: true, message: `${rows.length} restored.` };
}

/** Permanent deletion. Only ARCHIVED clients are eligible, so deleting is always a second, deliberate step after archiving. */
export async function deleteClients(ids: string[]): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.delete");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: "ARCHIVED" }, select: { id: true, code: true } });
  if (!rows.length) return { ok: false, message: "Only archived clients can be permanently deleted. Archive them first." };
  // `status: ARCHIVED` again in the delete itself: a client restored between the read above and this
  // statement must not be deleted. The count of what was REALLY deleted is what is reported and logged.
  const removed = await prisma.client.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, status: "ARCHIVED" } });
  if (removed.count === 0) return { ok: false, message: "Nothing was deleted — those clients are no longer archived." };
  // The record that it happened outlives the clients: how many, which codes, and who — never names or contact details.
  await logSystemEvent("WARN", "clients", `Permanently deleted ${removed.count} client(s)`, { count: removed.count, codes: rows.slice(0, 100).map((r) => r.code) }, { actorUserId: granted.session.userId, targetType: "Client" });
  await refresh();
  const notDeleted = clean.length - removed.count;
  return { ok: true, message: `${removed.count} permanently deleted${notDeleted ? `, ${notDeleted} skipped because they are not archived` : ""}. This cannot be undone.` };
}

export async function bulkAssignClients(ids: string[], memberId: string | null, teamId: string | null): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  if (memberId && !(await prisma.internalTeamMember.findFirst({ where: { id: memberId }, select: { id: true } }))) return { ok: false, message: "That staff member does not exist in this project." };
  if (teamId && !(await prisma.team.findFirst({ where: { id: teamId }, select: { id: true } }))) return { ok: false, message: "That team does not exist in this project." };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: { not: "ARCHIVED" } }, select: { id: true } });
  if (!rows.length) return { ok: true, message: "Nothing changed — those clients are archived or no longer exist." };
  await prisma.$transaction(async (tx) => {
    await tx.client.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { assignedMemberId: memberId, assignedTeamId: teamId } });
    await tx.clientActivity.createMany({ data: rows.map((r) => ({ clientId: r.id, actorUserId: granted.session.userId, type: "ASSIGNED", summary: memberId || teamId ? "Assignment changed" : "Assignment cleared" })) });
  });
  await refresh();
  return { ok: true, message: `${rows.length} updated.` };
}

export async function bulkSetClientStatus(ids: string[], status: string): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  if (!isClientStatus(status) || status === "ARCHIVED") return { ok: false, message: "Choose Active, Inactive, Pending or Blocked. Use Archive to archive." };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: { notIn: ["ARCHIVED", status] } }, select: { id: true, status: true } });
  if (!rows.length) return { ok: true, message: "Nothing changed — those clients already have that status, or are archived." };
  await prisma.$transaction(async (tx) => {
    await tx.client.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status } });
    await tx.clientActivity.createMany({
      data: rows.map((r) => ({ clientId: r.id, actorUserId: granted.session.userId, type: "STATUS_CHANGED", summary: `Status changed from ${r.status} to ${status}`, details: { from: r.status, to: status } })),
    });
  });
  await refresh();
  return { ok: true, message: `${rows.length} set to ${status.toLowerCase()}.` };
}

export async function bulkTagClients(ids: string[], add: string, remove: string): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const toAdd = normalizeTags(add);
  const toRemove = new Set(normalizeTags(remove));
  if (!toAdd.length && !toRemove.size) return { ok: false, message: "Enter at least one tag to add or remove." };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: { not: "ARCHIVED" } }, select: { id: true, tags: true } });
  let changed = 0;
  // Each client's own list is rewritten, so tags it already had survive. Chunked: not one long statement.
  for (let i = 0; i < rows.length; i += 100) {
    await Promise.all(
      rows.slice(i, i + 100).map(async (row) => {
        const next = normalizeTags([...row.tags.filter((t) => !toRemove.has(t)), ...toAdd]);
        if (next.join("|") === row.tags.join("|")) return;
        await prisma.client.update({ where: { id: row.id }, data: { tags: next } });
        await recordClientActivity(prisma, row.id, granted.session.userId, { type: "TAGS_CHANGED", summary: "Tags changed", details: { tags: next } });
        changed += 1;
      }),
    );
  }
  await refresh();
  return { ok: true, message: `${changed} updated${rows.length - changed ? `, ${rows.length - changed} already had those tags` : ""}.` };
}
