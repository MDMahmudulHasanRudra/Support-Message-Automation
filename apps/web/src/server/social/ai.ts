import { Prisma } from "@prisma/client";
import { SOCIAL_AI_TEXT_KINDS, validateSocialAiInput, type SocialAiKind } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { SocialRefusal } from "./posts";

/**
 * The web side of the AI Content Studio (SOCIAL_STUDIO.md §AI): it records a request for the worker
 * (which answers through the project's own Response model) and reads the answer back. Requests and
 * answers belong to the project (scoped client); nothing here publishes or changes a post.
 */

const MAX_OPEN_PER_PROJECT = 10;

export async function aiEngineOn(): Promise<boolean> {
  const settings = await prisma.aiSettings.findUnique({ where: { id: "global" }, select: { aiEngineEnabled: true } }).catch(() => null);
  return Boolean(settings?.aiEngineEnabled);
}

export async function createSocialAiRequest(raw: unknown, username: string): Promise<{ id: string }> {
  const input = validateSocialAiInput(raw);
  if (!input.ok) throw new SocialRefusal(input.reason);
  const open = await prisma.socialAiRequest.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } });
  if (open >= MAX_OPEN_PER_PROJECT) throw new SocialRefusal("Several AI requests are still being answered in this project. Wait a moment and try again.");
  return prisma.socialAiRequest.create({ data: { kind: input.value.kind, input: input.value as unknown as Prisma.InputJsonValue, requestedByUsername: username }, select: { id: true } });
}

export interface SocialAiRequestView {
  id: string;
  kind: SocialAiKind;
  status: string;
  options: string[];
  reason: string | null;
  brief: string;
  requestedByUsername: string;
  createdAt: string;
  textKind: boolean;
}

function view(r: { id: string; kind: string; status: string; options: string[]; reason: string | null; input: Prisma.JsonValue; requestedByUsername: string; createdAt: Date }): SocialAiRequestView {
  const input = validateSocialAiInput(r.input);
  return {
    id: r.id,
    kind: r.kind as SocialAiKind,
    status: r.status,
    options: r.options,
    reason: r.reason,
    brief: input.ok ? input.value.brief || input.value.text.slice(0, 200) : "",
    requestedByUsername: r.requestedByUsername,
    createdAt: r.createdAt.toISOString(),
    textKind: (SOCIAL_AI_TEXT_KINDS as readonly string[]).includes(r.kind),
  };
}

export async function readSocialAiRequest(id: string): Promise<SocialAiRequestView | null> {
  const row = await prisma.socialAiRequest.findFirst({ where: { id } });
  return row ? view(row) : null;
}

export async function listRecentSocialAiRequests(take = 20): Promise<SocialAiRequestView[]> {
  const rows = await prisma.socialAiRequest.findMany({ orderBy: { createdAt: "desc" }, take });
  return rows.map(view);
}

/** One option of a COMPLETE text request, to start a draft with (null when it is not one). */
export async function aiOptionForDraft(requestId: string, option: number): Promise<string | null> {
  const row = await prisma.socialAiRequest.findFirst({ where: { id: requestId, status: "COMPLETE" }, select: { kind: true, options: true } });
  if (!row || !(SOCIAL_AI_TEXT_KINDS as readonly string[]).includes(row.kind)) return null;
  return row.options[option] ?? null;
}
