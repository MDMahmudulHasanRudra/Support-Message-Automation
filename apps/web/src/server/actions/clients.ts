"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  groupLinkRefusal,
  hasSubscriptionInput,
  missingRequiredFields,
  normalizeCountryCode,
  normalizeCurrencyCode,
  validateSubscription,
  type ValidSubscription,
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
  cleanBusinessType,
  parseAdditionalLanguages,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { buildClientWhere, clientOrderBy, MAX_CLIENT_BULK, parseClientFilters } from "@/lib/clientFilters";
import { isCountryCode, readPhone } from "@/lib/clientPhone";
import { hasPermission } from "@/server/permissions";
import { canDeleteClientRecords, clientFilterContext, getClientModuleSettings } from "@/server/clientModule";
import { DELETE_REFUSED } from "@/lib/clientDeleteRule";
import { checkAssignment, sellerSnapshot } from "@/server/clientSubscriptionStore";
import { saveClientPhoto } from "@/server/clientPhotoStore";
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
  /** Nothing identifies the client: the form offers "Create with only a client code" as a separate press. */
  needsBlankConfirm?: boolean;
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
    if (typeof value === "string" && key !== "confirmDuplicate" && key !== "confirmBlank" && key !== "confirmGroup" && !key.startsWith("$ACTION")) out[key] = value.slice(0, 4000);
  }
  return out;
}

async function refresh(clientId?: string) {
  revalidatePath(await projectPath("/clients"));
  if (clientId) revalidatePath(await projectPath(`/clients/${clientId}`));
}

/**
 * The team and staff member the form named, from THIS project's real roster: a new assignment only to
 * an active team and member, and the member must be in the team when both are named. An assignment that
 * has since gone inactive may be kept as it is (`current`). Null = nobody.
 */
async function resolveAssignee(
  formData: FormData,
  current: { teamId: string | null; memberId: string | null } = { teamId: null, memberId: null },
): Promise<{ memberId: string | null; teamId: string | null } | { error: string }> {
  const memberId = text(formData, "assignedMemberId") || null;
  const teamId = text(formData, "assignedTeamId") || null;
  const refusal = await checkAssignment(teamId, memberId, current);
  return refusal ?? { memberId, teamId };
}

function readClientForm(formData: FormData) {
  return validateClientFields(
    {
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
    },
    // The form may save a client known only by its generated code (CLIENTS_V3.md §6); the import may not.
    { allowBlankName: true },
  );
}

/** V5: the business type and the languages besides the primary one, as typed (free text, checked). */
function readProfileExtras(formData: FormData, primaryLanguage: string | null): { businessType: string | null; additionalLanguages: string[] } | { error: string } {
  const business = cleanBusinessType(text(formData, "businessType"));
  if (!business.ok) return { error: business.error };
  const languages = parseAdditionalLanguages(text(formData, "additionalLanguages"), primaryLanguage);
  if (!languages.ok) return { error: languages.error };
  return { businessType: business.value, additionalLanguages: languages.languages };
}

/** Country and preferred currency as typed; each must be a real code when present. */
function readLocale(formData: FormData): { country: string | null; preferredCurrency: string | null } | { error: string } {
  const countryRaw = text(formData, "country");
  const country = countryRaw ? normalizeCountryCode(countryRaw) : null;
  if (countryRaw && (!country || !isCountryCode(country))) return { error: "Choose the country from the list." };
  const currencyRaw = text(formData, "preferredCurrency");
  const preferredCurrency = currencyRaw ? normalizeCurrencyCode(currencyRaw) : null;
  if (currencyRaw && !preferredCurrency) return { error: "The preferred currency must be a three-letter code, such as BDT." };
  return { country, preferredCurrency };
}

/** The seller named on the form: an active member of THIS project's roster, or nobody. */
async function readSeller(formData: FormData, keep: string | null = null): Promise<{ soldByMemberId: string | null } | { error: string }> {
  const id = text(formData, "soldByMemberId") || null;
  if (!id || id === keep) return { soldByMemberId: id };
  const seller = await sellerSnapshot(id);
  return "error" in seller ? seller : { soldByMemberId: id };
}

/**
 * A phone typed on the form, read with the numbering metadata: a valid number is stored in E.164
 * (+8801711000000). Anything else is passed on as typed to the older rule (`normalizeChannelDrafts`),
 * which still accepts a local Bangladeshi 01… number and refuses what is not a number at all — so a
 * stale metadata table, or a number typed without a country, never loses a client that saved before.
 */
function phoneValue(raw: string, country: string | null): string {
  return readPhone(raw, country).e164 ?? raw.trim();
}

export async function createClient(_prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.create");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };

  const parsed = readClientForm(formData);
  if (!parsed.value) return { error: parsed.errors.join(" "), values: echo(formData) };
  if (parsed.value.status === "ARCHIVED") return { error: "A new client cannot start archived.", values: echo(formData) };
  const locale = readLocale(formData);
  if ("error" in locale) return { error: locale.error, values: echo(formData) };
  const extras = readProfileExtras(formData, parsed.value.preferredLanguage);
  if ("error" in extras) return { error: extras.error, values: echo(formData) };
  const settings = await getClientModuleSettings();
  const country = locale.country ?? settings.defaultCountry;

  const drafts: ClientChannelDraft[] = [];
  const phoneRaw = text(formData, "phone");
  // "Same number on WhatsApp" is the usual case: one number, two channels (they match each other as duplicates anyway).
  const whatsappSame = formData.get("whatsappSame") === "1";
  const whatsappRaw = whatsappSame ? phoneRaw : text(formData, "whatsapp");
  const email = text(formData, "email");
  for (const [kind, raw] of [["PHONE", phoneRaw], ["WHATSAPP", whatsappRaw]] as const) {
    if (raw) drafts.push({ kind, value: phoneValue(raw, country), isPrimary: true });
  }
  if (email) drafts.push({ kind: "EMAIL", value: email, isPrimary: true });
  const channels = normalizeChannelDrafts(drafts);
  if (channels.errors.length) return { error: channels.errors.join(" "), values: echo(formData) };

  const assignee = await resolveAssignee(formData);
  if ("error" in assignee) return { error: assignee.error, values: echo(formData) };
  const seller = await readSeller(formData);
  if ("error" in seller) return { error: seller.error, values: echo(formData) };
  const photo = formData.get("photo");
  const hasPhoto = photo instanceof File && photo.size > 0;

  // The project's own required fields. A technical rule above is never relaxed by this.
  const fields = parsed.value;
  const missing = missingRequiredFields(settings.requiredFields, {
    name: Boolean(fields.name),
    companyName: Boolean(fields.companyName),
    phone: Boolean(phoneRaw || whatsappRaw),
    email: Boolean(email),
    country: Boolean(locale.country),
    address: Boolean(fields.address),
    preferredCurrency: Boolean(locale.preferredCurrency),
    category: Boolean(fields.category),
    assignedTeamId: Boolean(assignee.teamId),
    soldByMemberId: Boolean(seller.soldByMemberId),
    assignedMemberId: Boolean(assignee.memberId),
    photo: hasPhoto,
  });
  if (missing.length) return { error: missing.join(" "), values: echo(formData) };

  // A deliberately empty client (only a generated code) is allowed, but never by accident.
  const identifiable = Boolean(fields.name || fields.companyName || channels.channels.length);
  if (!identifiable && formData.get("confirmBlank") !== "1") {
    return {
      error: "A client needs a name, a company, a number or an email to be recognised later. To keep only a generated client code, confirm it.",
      needsBlankConfirm: true,
      values: echo(formData),
    };
  }

  // Optional subscription: all-or-nothing, and only with the key and the sub-module on.
  const subscriptionInput = {
    service: text(formData, "subService"),
    kind: text(formData, "subKind"),
    startDate: text(formData, "subStartDate"),
    durationValue: text(formData, "subDurationValue"),
    durationUnit: text(formData, "subDurationUnit"),
    endDate: text(formData, "subEndDate"),
    note: "",
  };
  let term: ValidSubscription | null = null;
  if (hasSubscriptionInput(subscriptionInput)) {
    if (!settings.subscriptions) return { error: "Subscriptions are switched off for this project (Settings → Clients). Clear the subscription fields to create the client.", values: echo(formData) };
    if (!(await hasPermission(granted.session, "clients.manage_subscriptions"))) return { error: "Adding a subscription needs the Sell, Renew and Cancel Client Subscriptions permission. Clear those fields, or ask someone who has it.", values: echo(formData) };
    const checked = validateSubscription(subscriptionInput);
    if (!checked.ok) return { error: `Subscription: ${checked.errors.join(" ")}`, values: echo(formData) };
    term = checked.value;
  }
  const saleSeller = term ? await sellerSnapshot(seller.soldByMemberId) : null;
  if (saleSeller && "error" in saleSeller) return { error: saleSeller.error, values: echo(formData) };

  // Optional WhatsApp group: confirmed in the form's dialog, checked here exactly as the link action does.
  const groupId = text(formData, "linkGroupId");
  const groupAccountId = text(formData, "linkAccountId");
  let group: { id: string; name: string; whatsappGroupId: string; accountId: string } | null = null;
  if (groupId) {
    if (formData.get("confirmGroup") !== "1") return { error: "Confirm the WhatsApp group link first.", values: echo(formData) };
    if (!settings.whatsappGroups) return { error: "WhatsApp group links are switched off for this project.", values: echo(formData) };
    if (!(await hasPermission(granted.session, "clients.link_whatsapp_group"))) return { error: "Linking a WhatsApp group needs the Link WhatsApp Groups to Clients permission.", values: echo(formData) };
    const row = await prisma.whatsAppGroup.findFirst({ where: { id: groupId }, select: { id: true, name: true, whatsappGroupId: true, isActive: true, accountId: true } });
    const refusal = groupLinkRefusal(row, groupAccountId);
    if (refusal) return { error: refusal, values: echo(formData) };
    const owner = await prisma.clientWhatsAppGroupLink.findFirst({ where: { unlinkedAt: null, whatsappGroupId: row!.whatsappGroupId }, select: { client: { select: { code: true, name: true } } } });
    if (owner) return { error: `That WhatsApp group is already linked to ${owner.client.name || "Unnamed client"} (${owner.client.code}).`, values: echo(formData) };
    group = row;
  }

  const duplicates = await findDuplicateClients({ channels: channels.channels, code: fields.code });
  if (duplicates.length && formData.get("confirmDuplicate") !== "1") {
    return { error: "This looks like a client you already have. Check the matches below, or create it anyway.", duplicates, values: echo(formData) };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
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
          additionalLanguages: extras.additionalLanguages,
          businessType: extras.businessType,
          address: fields.address,
          businessDetails: fields.businessDetails,
          followUpInstructions: fields.followUpInstructions,
          tags: fields.tags,
          customFields: fields.customFields,
          source: "MANUAL",
          country: locale.country,
          preferredCurrency: locale.preferredCurrency,
          soldByMemberId: seller.soldByMemberId,
          assignedMemberId: assignee.memberId,
          assignedTeamId: assignee.teamId,
          createdById: granted.session.userId,
          channels: { create: channels.channels.map((c) => channelFields(c, "recorded by staff")) },
        },
        select: { id: true },
      });
      await recordClientActivity(tx, created.id, granted.session.userId, { type: "CREATED", summary: `Client ${code} created by staff` });
      if (hasPhoto) {
        const saved = await saveClientPhoto(tx, created.id, photo, granted.session.userId);
        if (!saved.ok) throw new PhotoRefused(saved.message);
      }
      if (term && saleSeller && !("error" in saleSeller)) {
        const sub = await tx.clientSubscription.create({
          data: {
            clientId: created.id,
            service: term.service,
            kind: term.kind,
            startDate: new Date(`${term.startDate}T00:00:00.000Z`),
            endDate: new Date(`${term.endDate}T00:00:00.000Z`),
            durationValue: term.durationValue,
            durationUnit: term.durationUnit,
            ...saleSeller,
            createdById: granted.session.userId,
          },
          select: { id: true },
        });
        await tx.client.update({ where: { id: created.id }, data: { currentSubscriptionId: sub.id } });
        await recordClientActivity(tx, created.id, granted.session.userId, { type: "SUBSCRIPTION_ADDED", summary: `Subscription added: ${term.service} (${term.startDate} → ${term.endDate})`, details: { subscriptionId: sub.id } });
      }
      if (group) {
        await tx.clientWhatsAppGroupLink.create({ data: { clientId: created.id, accountId: group.accountId, groupId: group.id, whatsappGroupId: group.whatsappGroupId, groupName: group.name, linkedById: granted.session.userId } });
        await recordClientActivity(tx, created.id, granted.session.userId, { type: "GROUP_LINKED", summary: `WhatsApp group linked: ${group.name}`, details: { groupId: group.id } });
      }
      return created.id;
    });
    if (group) await logSystemEvent("INFO", "clients", "WhatsApp group linked to a client", { clientId: result, groupId: group.id, accountId: group.accountId }, { actorUserId: granted.session.userId, targetType: "Client", targetId: result });
    await refresh();
    return { success: true, clientId: result };
  } catch (err) {
    if (err instanceof PhotoRefused) return { error: `Photo: ${err.message}`, values: echo(formData) };
    if (isUniqueViolation(err)) return { error: group ? "That client code is already used, or the WhatsApp group was just linked to another client." : "That client code is already used by another client.", values: echo(formData) };
    throw err;
  }
}

class PhotoRefused extends Error {}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  companyName: "company",
  category: "category",
  preferredChannel: "preferred channel",
  preferredLanguage: "preferred language",
  businessType: "business type",
  additionalLanguages: "other languages",
  address: "address",
  businessDetails: "business details",
  followUpInstructions: "follow-up instructions",
  code: "client code",
  country: "country",
  preferredCurrency: "preferred currency",
  soldByMemberId: "sold by",
};

export async function updateClient(clientId: string, _prev: ClientFormState, formData: FormData): Promise<ClientFormState> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };

  const current = await prisma.client.findFirst({ where: { id: clientId }, include: { channels: { select: { kind: true } }, photo: { select: { id: true } } } });
  if (!current) return { error: "That client no longer exists.", values: echo(formData) };

  const parsed = readClientForm(formData);
  if (!parsed.value) return { error: parsed.errors.join(" "), values: echo(formData) };
  const fields = parsed.value;
  if (fields.status === "ARCHIVED" && current.status !== "ARCHIVED") return { error: "Use Archive to archive a client.", values: echo(formData) };
  if (current.status === "ARCHIVED" && fields.status !== "ARCHIVED") return { error: "Restore this client before editing it.", values: echo(formData) };
  const assignee = await resolveAssignee(formData, { teamId: current.assignedTeamId, memberId: current.assignedMemberId });
  if ("error" in assignee) return { error: assignee.error, values: echo(formData) };
  // An older form without the V3 fields leaves them as they are.
  const locale = formData.has("country") || formData.has("preferredCurrency") ? readLocale(formData) : { country: current.country, preferredCurrency: current.preferredCurrency };
  if ("error" in locale) return { error: locale.error, values: echo(formData) };
  const seller = formData.has("soldByMemberId") ? await readSeller(formData, current.soldByMemberId) : { soldByMemberId: current.soldByMemberId };
  if ("error" in seller) return { error: seller.error, values: echo(formData) };
  // A form without the V5 fields leaves them as they are.
  const extras =
    formData.has("businessType") || formData.has("additionalLanguages")
      ? readProfileExtras(formData, fields.preferredLanguage)
      : { businessType: current.businessType, additionalLanguages: current.additionalLanguages };
  if ("error" in extras) return { error: extras.error, values: echo(formData) };

  const settings = await getClientModuleSettings();
  const kinds = new Set(current.channels.map((c) => c.kind));
  const missing = missingRequiredFields(settings.requiredFields, {
    name: Boolean(fields.name),
    companyName: Boolean(fields.companyName),
    phone: kinds.has("PHONE") || kinds.has("WHATSAPP"),
    email: kinds.has("EMAIL"),
    country: Boolean(locale.country),
    address: Boolean(fields.address),
    preferredCurrency: Boolean(locale.preferredCurrency),
    category: Boolean(fields.category),
    assignedTeamId: Boolean(assignee.teamId),
    soldByMemberId: Boolean(seller.soldByMemberId),
    assignedMemberId: Boolean(assignee.memberId),
    photo: Boolean(current.photo),
  });
  if (missing.length) return { error: missing.join(" "), values: echo(formData) };

  const code = fields.code ?? current.code; // clearing the code keeps the old one: a client always has one
  const next = {
    name: fields.name,
    companyName: fields.companyName,
    category: fields.category,
    preferredChannel: fields.preferredChannel,
    preferredLanguage: fields.preferredLanguage,
    businessType: extras.businessType,
    address: fields.address,
    businessDetails: fields.businessDetails,
    followUpInstructions: fields.followUpInstructions,
    code,
    country: locale.country,
    preferredCurrency: locale.preferredCurrency,
    soldByMemberId: seller.soldByMemberId,
  };
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => (current[k] ?? null) !== (next[k] ?? null));
  const tagsChanged = [...current.tags].sort().join("|") !== [...fields.tags].sort().join("|");
  if (current.additionalLanguages.join("|") !== extras.additionalLanguages.join("|")) (changed as string[]).push("additionalLanguages");

  try {
    await prisma.$transaction(async (tx) => {
      await tx.client.update({
        where: { id: clientId },
        data: {
          ...next,
          additionalLanguages: extras.additionalLanguages,
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
  const ctx = await clientFilterContext(granted.session);
  const rows = await prisma.client.findMany({ where: buildClientWhere(filters, ctx), select: { id: true }, orderBy: clientOrderBy("name", "asc"), take: MAX_CLIENT_BULK + 1 });
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

/**
 * Permanently deletes clients — an Administrator (Main Admin), or a role an Administrator gave
 * `clients.delete` (`canDeleteClientRecords`; the owner's rule, 17 Oct 2026). Any status may be
 * deleted (archiving first is no longer required). Everything that belongs to a client goes with it:
 * channels, notes, timeline, subscriptions, invoices, payments and group/chat links. The System Log
 * keeps how many, which codes and who — never names or contact details.
 */
export async function deleteClients(ids: string[]): Promise<BulkClientResult> {
  // The project and the Client Management feature are checked as for any client action…
  const granted = await checkPermission("clients.view");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  // …and the delete itself needs an Administrator, or the delete permission an Administrator gave.
  if (!(await canDeleteClientRecords(granted.session))) return { ok: false, message: DELETE_REFUSED };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const rows = await prisma.client.findMany({ where: { id: { in: clean } }, select: { id: true, code: true } });
  if (!rows.length) return { ok: false, message: "Those clients no longer exist." };
  const removed = await prisma.$transaction(async (tx) => {
    // The current-term pointer is cleared first so the subscriptions it points at can go in one statement.
    await tx.client.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { currentSubscriptionId: null } });
    return tx.client.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });
  await logSystemEvent("WARN", "clients", `Permanently deleted ${removed.count} client(s)`, { count: removed.count, codes: rows.slice(0, 100).map((r) => r.code) }, { actorUserId: granted.session.userId, targetType: "Client" });
  await refresh();
  const missing = clean.length - removed.count;
  return { ok: true, message: `${removed.count} client(s) permanently deleted${missing ? `, ${missing} no longer existed` : ""}. This cannot be undone.` };
}

export interface BulkDetailsPatch {
  /** "" = leave as is; "__none" = clear; otherwise the new value. */
  teamId?: string;
  soldByMemberId?: string;
  country?: string;
  preferredCurrency?: string;
}

/**
 * Sets the same team, seller, country or preferred currency on many clients — the fields that are
 * tedious one by one after an import. Each value is checked like the form checks it: a NEW team must
 * be active, a seller an active roster member, a country a real region, a currency three letters.
 * Archived clients are skipped. Changing the team clears an assigned staff member who is not in it.
 */
export async function bulkSetClientDetails(ids: string[], patch: BulkDetailsPatch): Promise<BulkClientResult> {
  const granted = await checkPermission("clients.update");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: TOO_MANY };
  const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const team = pick(patch?.teamId);
  const seller = pick(patch?.soldByMemberId);
  const countryRaw = pick(patch?.country);
  const currencyRaw = pick(patch?.preferredCurrency);
  const data: Prisma.ClientUpdateManyMutationInput & { assignedTeamId?: string | null; soldByMemberId?: string | null } = {};
  const changed: string[] = [];
  if (team) {
    if (team === "__none") data.assignedTeamId = null;
    else {
      const refusal = await checkAssignment(team, null);
      if (refusal) return { ok: false, message: refusal.error };
      data.assignedTeamId = team;
    }
    changed.push("team");
  }
  if (seller) {
    if (seller === "__none") data.soldByMemberId = null;
    else {
      const s = await sellerSnapshot(seller);
      if ("error" in s) return { ok: false, message: s.error };
      data.soldByMemberId = seller;
    }
    changed.push("sold by");
  }
  if (countryRaw) {
    if (countryRaw === "__none") data.country = null;
    else {
      const c = normalizeCountryCode(countryRaw);
      if (!c || !isCountryCode(c)) return { ok: false, message: "Choose the country from the list." };
      data.country = c;
    }
    changed.push("country");
  }
  if (currencyRaw) {
    if (currencyRaw === "__none") data.preferredCurrency = null;
    else {
      const c = normalizeCurrencyCode(currencyRaw);
      if (!c) return { ok: false, message: "The currency must be a three-letter code, such as BDT." };
      data.preferredCurrency = c;
    }
    changed.push("preferred currency");
  }
  if (!changed.length) return { ok: false, message: "Choose at least one thing to set." };
  const rows = await prisma.client.findMany({ where: { id: { in: clean }, status: { not: "ARCHIVED" } }, select: { id: true, assignedMemberId: true, assignedMember: { select: { teamId: true } } } });
  if (!rows.length) return { ok: true, message: "Nothing changed — those clients are archived or no longer exist." };
  await prisma.$transaction(async (tx) => {
    await tx.client.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data });
    if (data.assignedTeamId) {
      // A staff member outside the new team would contradict it: cleared, like the form requires.
      const outside = rows.filter((r) => r.assignedMemberId && r.assignedMember?.teamId !== data.assignedTeamId).map((r) => r.id);
      if (outside.length) await tx.client.updateMany({ where: { id: { in: outside } }, data: { assignedMemberId: null } });
    }
    await tx.clientActivity.createMany({ data: rows.map((r) => ({ clientId: r.id, actorUserId: granted.session.userId, type: "UPDATED", summary: `Updated ${changed.join(", ")} (bulk)` })) });
  });
  await refresh();
  return { ok: true, message: `${rows.length} updated (${changed.join(", ")}).${rows.length < clean.length ? ` ${clean.length - rows.length} archived skipped.` : ""}` };
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
