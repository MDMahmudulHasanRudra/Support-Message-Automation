import { isUniqueViolation } from "@/lib/prismaErrors";
import { platformPrisma } from "@/server/db";
import { exchangeCode, fetchIdentity, type FetchImpl } from "@/server/google/api";
import type { GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * A person's own Google identity (GOOGLE_SHEETS.md §5, Phase 4). Linked only by that person signing
 * in with Google themselves — the one bridge from an edit Google reports (`people/<id>`) to a person
 * in the app. Never inferred from a matching email or name, and never set by anybody else.
 *
 * Platform data (no project): a person's Google account is the same in every project, so this reads
 * and writes through the platform client, always for the signed-in person only.
 *
 * No token is kept. The access token from the sign-in is used once to read the account id and then
 * simply dropped — deliberately NOT revoked: Google revokes a whole grant, and the same Google account
 * is often also connected to a project (the Lead's own account), whose access must survive this.
 */

export class GoogleIdentityError extends Error {
  constructor(
    public readonly code: "GOOGLE_REFUSED" | "LINKED_ELSEWHERE",
    message: string,
  ) {
    super(message);
    this.name = "GoogleIdentityError";
  }
}

export interface LinkedGoogleIdentity {
  id: string;
  email: string;
  displayName: string | null;
  verifiedAt: Date;
}

export async function listMyGoogleIdentities(userId: string): Promise<LinkedGoogleIdentity[]> {
  return platformPrisma.userGoogleIdentity.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, displayName: true, verifiedAt: true },
  });
}

/** Finish "Link my Google account": redeem the code, learn who the account is, record it for this person. */
export async function completeIdentityLink(input: { config: GoogleOAuthConfig; code: string; verifier: string; userId: string; fetchImpl?: FetchImpl; now?: Date }): Promise<LinkedGoogleIdentity> {
  let identity;
  try {
    const tokens = await exchangeCode(input.config, input.code, input.verifier, input.fetchImpl);
    identity = await fetchIdentity(tokens.accessToken, input.fetchImpl);
  } catch (err) {
    throw new GoogleIdentityError("GOOGLE_REFUSED", (err as Error).message);
  }
  const now = input.now ?? new Date();
  const existing = await platformPrisma.userGoogleIdentity.findUnique({ where: { googleSubject: identity.subject }, select: { id: true, userId: true } });
  if (existing && existing.userId !== input.userId) {
    throw new GoogleIdentityError("LINKED_ELSEWHERE", `${identity.email} is already linked to another login. Ask that person to unlink it first.`);
  }
  const fields = { email: identity.email, displayName: identity.name, verifiedAt: now };
  try {
    return await platformPrisma.userGoogleIdentity.upsert({
      where: { googleSubject: identity.subject },
      create: { userId: input.userId, googleSubject: identity.subject, ...fields },
      update: fields,
      select: { id: true, email: true, displayName: true, verifiedAt: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new GoogleIdentityError("LINKED_ELSEWHERE", `${identity.email} was just linked to another login.`);
    throw err;
  }
}

/** Unlink one of the person's OWN identities. Activity already credited keeps who it was credited to. */
export async function unlinkMyGoogleIdentity(userId: string, identityId: string): Promise<LinkedGoogleIdentity | null> {
  const row = await platformPrisma.userGoogleIdentity.findFirst({ where: { id: identityId, userId }, select: { id: true, email: true, displayName: true, verifiedAt: true } });
  if (!row) return null;
  await platformPrisma.userGoogleIdentity.delete({ where: { id: row.id } });
  return row;
}

/** Which of these logins have linked a Google identity (and which), for the members list. */
export async function identitiesForUsers(userIds: string[]): Promise<Map<string, string[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await platformPrisma.userGoogleIdentity.findMany({ where: { userId: { in: userIds } }, select: { userId: true, email: true } });
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.userId, [...(out.get(row.userId) ?? []), row.email]);
  return out;
}
