"use server";

import {
  parseWhatsAppId,
  previewIdentityChange,
  whatsappIdKey,
  normalizePhoneNumber,
  type IdentityPreviewResult,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { isUnifiedReportingEnabled } from "@/server/unifiedReporting";
import { dhakaDayStart, readIdentityFields } from "@/lib/teamMemberIdentity";
import {
  applyProposal,
  estimateIdentityKpiDeltas,
  loadIdentityPreviewInput,
  loadPreviewRoster,
  previewDigest,
  previewIdentifiers,
  previewWindow,
  PREVIEW_NEW_MEMBER_ID,
  type IdentityKpiDelta,
  type IdentityProposal,
} from "@/server/identityPreview";

/**
 * The impact preview of a team-member identity change. READ-ONLY: it writes nothing and queues no
 * IdentityReattribution — approval is the existing Save, which this never calls. Gated by the key of
 * the actions it previews (`whatsapp.manage`), the UNIFIED_REPORTING feature, and the project.
 */
export interface IdentityPreviewRequest {
  /** null = a new member. */
  memberId: string | null;
  /** The values as the form carries them (attributeFrom as YYYY-MM-DD, the form's own value). */
  proposed: { phoneNumber: string; whatsappId: string | null; attributeFrom?: string | null } | null;
  /** WhatsApp Chat's link panel: the sender id being linked to `memberId` (the proposal is derived here). */
  linkSenderId?: string;
  /** Clamped to [1, 365]; default 92. */
  days?: number;
}

export type IdentityPreviewResponse =
  | { ok: true; preview: Omit<IdentityPreviewResult, "kpiScope">; kpi: IdentityKpiDelta | null; digest: string; showPersonal: boolean; newMemberId: string; memberNames: Record<string, string> }
  | { ok: false; error: string };

export async function previewTeamMemberIdentityChange(req: IdentityPreviewRequest): Promise<IdentityPreviewResponse> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  if (!(await isUnifiedReportingEnabled())) return { ok: false, error: "Impact preview is not enabled for this project." };

  const roster = await loadPreviewRoster();
  const current = req.memberId ? roster.find((m) => m.id === req.memberId) : undefined;
  if (req.memberId && !current) return { ok: false, error: "That team member no longer exists." };

  let proposal: IdentityProposal;
  if (req.linkSenderId !== undefined) {
    // The link panel's own rules (linkWhatsAppSender): a person's id, digits, and only a member with no id of their own.
    if (!current) return { ok: false, error: "Pick the team member this person is." };
    const parsed = parseWhatsAppId(req.linkSenderId);
    if (!parsed || parsed.kind === "GROUP" || parsed.kind === "BROADCAST" || parsed.kind === "NEWSLETTER") {
      return { ok: false, error: "That is not a person's WhatsApp ID, so it cannot be linked to anyone." };
    }
    const key = whatsappIdKey(req.linkSenderId);
    if (!key || !/^\d{6,}$/.test(key)) return { ok: false, error: "That WhatsApp ID is not in a form that can be stored. Nothing was changed." };
    const placeholder = Boolean(current.whatsappId) && normalizePhoneNumber(whatsappIdKey(current.whatsappId) ?? "") === normalizePhoneNumber(current.phoneNumber);
    if (current.whatsappId && !placeholder && whatsappIdKey(current.whatsappId) !== key) {
      return { ok: false, error: `This member already has WhatsApp ID ${current.whatsappId}. Change it on their edit page if this is really them.` };
    }
    proposal = { phoneNumber: current.phoneNumber, whatsappId: key };
  } else {
    if (!req.proposed) return { ok: false, error: "Nothing to preview." };
    const fields = readIdentityFields({ phoneNumber: req.proposed.phoneNumber, whatsappId: req.proposed.whatsappId });
    if ("error" in fields) return { ok: false, error: fields.error };
    let attributeFrom: Date | null | undefined;
    if (req.proposed.attributeFrom !== undefined) {
      const key = String(req.proposed.attributeFrom ?? "").trim();
      attributeFrom = key ? dhakaDayStart(key) : null;
      if (attributeFrom === undefined) return { ok: false, error: "That date could not be read. Pick a day, or leave it empty to count every message." };
    }
    proposal = { ...fields, attributeFrom };
  }

  const now = new Date();
  const window = previewWindow(req.days, now);
  const showPersonal = await hasPermission(granted.session, "messages.view");
  const rosterAfter = applyProposal(roster, req.memberId, proposal);
  const loaded = await loadIdentityPreviewInput({ identifiers: previewIdentifiers(roster, rosterAfter, req.memberId), window });
  // Without messages.view the viewer may not learn anything about personal chats, so none is read into any count.
  const messages = showPersonal ? loaded.messages : loaded.messages.filter((m) => m.conversationKind === "GROUP");
  const preview = previewIdentityChange({
    rosterBefore: roster,
    rosterAfter,
    ownIds: loaded.ownIds,
    messages,
    window: { from: window.from.getTime(), to: window.to.getTime() },
    truncated: loaded.truncated,
  });
  const kpi = await estimateIdentityKpiDeltas({ preview, rosterBefore: roster, rosterAfter, now, showPersonal });
  const { kpiScope: _scope, ...rest } = preview;
  void _scope;
  // A personal conversation's key holds the customer's chat id (a number or a LID): the browser gets a
  // placeholder, never an identifier it could print as a phone number.
  const visible = { ...rest, samples: rest.samples.map((s) => (s.conversationKind === "PERSONAL" ? { ...s, conversationKey: "personal" } : s)) };
  const members = await prisma.internalTeamMember.findMany({ select: { id: true, name: true } });
  const memberNames = Object.fromEntries(members.map((m) => [m.id, m.name]));
  return { ok: true, preview: visible, kpi, digest: previewDigest(preview), showPersonal, newMemberId: PREVIEW_NEW_MEMBER_ID, memberNames };
}
