import type { Prisma } from "@prisma/client";
import { allocateClientCode } from "@support-automation/db";
import {
  findDuplicateMatches,
  matchKeyOf,
  type ClientChannelKindValue,
  type DuplicateMatch,
  type NormalizedChannel,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Shared plumbing for the client actions and the import. Not a "use server" file: nothing here is an
 * endpoint, and every caller has already passed its own permission check. All reads and writes go
 * through the project-scoped client, so another project's clients are neither matched nor touched.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The project's next client code ("0001", "N0001" — CLIENT_CODES.md), from its own series inside the caller's
 * transaction. A typed code that collides is the caller's validation error, not this one's.
 */
export async function nextClientCode(db: Db = prisma): Promise<string> {
  return allocateClientCode(db, await activeProjectId());
}

export interface TimelineEntry {
  type: string;
  summary: string;
  details?: Prisma.InputJsonValue;
}

/** One timeline row. Never carries a message body or a note's text — what happened, not what was said. */
export async function recordClientActivity(db: Db, clientId: string, actorUserId: string | null, entry: TimelineEntry): Promise<void> {
  await db.clientActivity.create({
    data: { clientId, actorUserId, type: entry.type, summary: entry.summary.slice(0, 300), details: entry.details },
  });
}

const PHONE_KINDS: ClientChannelKindValue[] = ["PHONE", "WHATSAPP"];

/** The channel rows a match key refers to: a phone key matches PHONE and WHATSAPP rows alike. */
function channelWhereForKey(key: string): Prisma.ClientChannelWhereInput | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const group = key.slice(0, at);
  const value = key.slice(at + 1);
  if (group === "phone") return { kind: { in: PHONE_KINDS }, normalizedValue: value };
  const kind = group.toUpperCase() as ClientChannelKindValue;
  return { kind, normalizedValue: value };
}

export interface DuplicateClient extends DuplicateMatch {
  code: string;
  name: string;
  status: string;
}

/**
 * Existing clients that share an identifier with what is being entered: a phone or WhatsApp number,
 * an email, an external reference, or the client code. Never a similar name. Looks at archived
 * clients too — a returning client should be restored, not created twice.
 */
export async function findDuplicateClients(
  incoming: { channels: readonly NormalizedChannel[]; code?: string | null; excludeClientId?: string | null },
  db: Db = prisma,
): Promise<DuplicateClient[]> {
  const keys = [...new Set(incoming.channels.map((c) => c.matchKey))];
  const conditions = keys.map(channelWhereForKey).filter((c): c is Prisma.ClientChannelWhereInput => c !== null);
  const code = incoming.code?.trim() || null;
  if (!conditions.length && !code) return [];

  const clients = await db.client.findMany({
    where: {
      ...(incoming.excludeClientId ? { id: { not: incoming.excludeClientId } } : {}),
      OR: [
        ...(conditions.length ? [{ channels: { some: { OR: conditions } } }] : []),
        ...(code ? [{ code: { equals: code, mode: "insensitive" as const } }] : []),
      ],
    },
    select: { id: true, code: true, name: true, status: true, channels: { select: { kind: true, normalizedValue: true } } },
    take: 50,
  });

  const matches = findDuplicateMatches(
    { matchKeys: keys, code, excludeClientId: incoming.excludeClientId },
    clients.map((c) => ({ clientId: c.id, code: c.code, matchKeys: c.channels.map((ch) => matchKeyOf(ch.kind, ch.normalizedValue)) })),
  );
  const byId = new Map(clients.map((c) => [c.id, c]));
  return matches.flatMap((m) => {
    const c = byId.get(m.clientId);
    return c ? [{ ...m, code: c.code, name: c.name, status: c.status }] : [];
  });
}

/** The writable fields of a normalized channel; consent stays UNKNOWN until somebody records it. */
export function channelFields(channel: NormalizedChannel, consentSource: string | null = null) {
  return {
    kind: channel.kind,
    value: channel.value,
    normalizedValue: channel.normalizedValue,
    label: channel.label,
    isPrimary: channel.isPrimary,
    consentSource,
  };
}

/**
 * Which existing clients an import's rows already match, in two lookups for the whole file instead of
 * two per row: every channel identifier and every typed code, mapped to the client that holds it.
 * Archived clients count (a returning client is matched, not created twice).
 */
export async function loadExistingMatches(
  matchKeys: readonly string[],
  codes: readonly string[],
  db: Db = prisma,
): Promise<{ byKey: Map<string, string>; byCode: Map<string, string> }> {
  const byKey = new Map<string, string>();
  const byCode = new Map<string, string>();
  const keys = [...new Set(matchKeys)];
  for (let i = 0; i < keys.length; i += 500) {
    const conditions = keys.slice(i, i + 500).map(channelWhereForKey).filter((c): c is Prisma.ClientChannelWhereInput => c !== null);
    if (!conditions.length) continue;
    const rows = await db.clientChannel.findMany({ where: { OR: conditions }, select: { clientId: true, kind: true, normalizedValue: true } });
    for (const row of rows) {
      const key = matchKeyOf(row.kind, row.normalizedValue);
      if (!byKey.has(key)) byKey.set(key, row.clientId);
    }
  }
  const wanted = [...new Set(codes.map((c) => c.toLowerCase()))];
  for (let i = 0; i < wanted.length; i += 500) {
    const rows = await db.client.findMany({ where: { OR: wanted.slice(i, i + 500).map((code) => ({ code: { equals: code, mode: "insensitive" as const } })) }, select: { id: true, code: true } });
    for (const row of rows) byCode.set(row.code.toLowerCase(), row.id);
    // A former code, or the code a file gave the client, still names it (CLIENT_CODES.md §Aliases).
    const aliases = await db.clientCodeAlias.findMany({ where: { canonical: { in: wanted.slice(i, i + 500).map((c) => c.trim().toUpperCase()) } }, select: { canonical: true, clientId: true } });
    for (const alias of aliases) if (!byCode.has(alias.canonical.toLowerCase())) byCode.set(alias.canonical.toLowerCase(), alias.clientId);
  }
  return { byKey, byCode };
}
