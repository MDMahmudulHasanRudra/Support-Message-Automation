import { createHash } from "node:crypto";
import type { SheetActionType, UnattributedReason } from "@support-automation/shared";

/**
 * Reading Google's Drive Activity records (GOOGLE_SHEETS.md §3, Phase 8) — pure, so the rules that
 * decide who gets credit are unit-tested without a database or a network.
 *
 * What Google gives: per activity, `primaryActionDetail` (edit, create, rename, …), `actors[]` and a
 * `timestamp` (or a `timeRange`). An actor may be a known user (`people/<id>`, plus `isCurrentUser`
 * when it is the account asking), a deleted or unknown user, an anonymous visitor, an administrator,
 * an impersonation or Google itself. It never says which cells, and never for how long.
 *
 * The crediting rule, conservative on purpose — crediting the wrong employee is worse than crediting
 * nobody:
 *   - exactly ONE actor, and it is a known user;
 *   - whose id is a Google identity a person linked THEMSELVES (UserGoogleIdentity);
 *   - and Google has been SEEN to use sign-in's account id here (the identity bridge is VERIFIED, and
 *     never contradicted).
 * Anything else is UNATTRIBUTED, with the reason.
 */

export type ParsedActor =
  | { kind: "KNOWN_USER"; personId: string | null; isCurrentUser: boolean }
  | { kind: "DELETED_USER" | "UNKNOWN_USER" | "ANONYMOUS" | "IMPERSONATION" | "SYSTEM" | "ADMINISTRATOR" | "OTHER" };

export interface DriveActivityRecord {
  /** Deterministic: the same Google record always gives the same key, so a re-read never duplicates. */
  key: string;
  occurredAt: Date;
  actionType: SheetActionType;
  actors: ParsedActor[];
}

const ACTIONS: Array<[string, SheetActionType]> = [
  ["edit", "EXTERNAL_EDIT"],
  ["create", "EXTERNAL_CREATE"],
  ["rename", "EXTERNAL_RENAME"],
  ["delete", "EXTERNAL_DELETE"],
  ["restore", "EXTERNAL_RESTORE"],
  ["comment", "EXTERNAL_COMMENT"],
  ["permissionChange", "EXTERNAL_PERMISSION_CHANGE"],
  ["move", "EXTERNAL_MOVE"],
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** "people/12345" → "12345". */
export function personIdOf(personName: unknown): string | null {
  if (typeof personName !== "string") return null;
  const match = /^people\/([^/\s]+)$/.exec(personName.trim());
  return match ? match[1]! : null;
}

function parseActor(actor: unknown): ParsedActor {
  if (!isObj(actor)) return { kind: "OTHER" };
  if (isObj(actor.user)) {
    const user = actor.user;
    if (isObj(user.knownUser)) return { kind: "KNOWN_USER", personId: personIdOf(user.knownUser.personName), isCurrentUser: user.knownUser.isCurrentUser === true };
    if (isObj(user.deletedUser)) return { kind: "DELETED_USER" };
    return { kind: "UNKNOWN_USER" };
  }
  if (isObj(actor.anonymous)) return { kind: "ANONYMOUS" };
  if (isObj(actor.impersonation)) return { kind: "IMPERSONATION" };
  if (isObj(actor.system)) return { kind: "SYSTEM" };
  if (isObj(actor.administrator)) return { kind: "ADMINISTRATOR" };
  return { kind: "OTHER" };
}

function timeOf(activity: Obj): { at: Date; raw: string } | null {
  const raw = typeof activity.timestamp === "string" ? activity.timestamp : isObj(activity.timeRange) && typeof activity.timeRange.endTime === "string" ? activity.timeRange.endTime : null;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : { at, raw: typeof activity.timestamp === "string" ? raw : `${String((activity.timeRange as Obj).startTime ?? "")}/${raw}` };
}

/** One Google activity as a record, or null when it has no usable time. */
export function parseDriveActivity(activity: unknown, fileId: string): DriveActivityRecord | null {
  if (!isObj(activity)) return null;
  const time = timeOf(activity);
  if (!time) return null;
  const detail = isObj(activity.primaryActionDetail) ? activity.primaryActionDetail : {};
  const action = ACTIONS.find(([key]) => key in detail);
  const actionKey = action ? action[0] : Object.keys(detail).sort()[0] ?? "unknown";
  const actors = (Array.isArray(activity.actors) ? activity.actors : []).map(parseActor);
  const actorSignature = actors
    .map((a) => (a.kind === "KNOWN_USER" ? `user:${a.personId ?? "?"}` : a.kind.toLowerCase()))
    .sort()
    .join(",");
  const key = createHash("sha256").update(JSON.stringify([fileId, time.raw, actionKey, actorSignature])).digest("hex").slice(0, 40);
  return { key, occurredAt: time.at, actionType: action ? action[1] : "EXTERNAL_OTHER", actors };
}

/** Whether Google has been seen to use sign-in's account ids in Drive Activity for this project. */
export type IdentityBridge = "VERIFIED" | "UNVERIFIED" | "MISMATCH";

/**
 * The account's OWN activity (`isCurrentUser`) proves or disproves that `people/<id>` is the same
 * number as the account's sign-in id. Null when the record says nothing about it.
 */
export function bridgeEvidence(record: DriveActivityRecord, accountSubject: string): "MATCH" | "MISMATCH" | null {
  if (record.actors.length !== 1) return null;
  const actor = record.actors[0]!;
  if (actor.kind !== "KNOWN_USER" || !actor.isCurrentUser || !actor.personId) return null;
  return actor.personId === accountSubject ? "MATCH" : "MISMATCH";
}

export type AttributionDecision =
  | { attribution: "ATTRIBUTED"; userId: string; personId: string }
  | { attribution: "UNATTRIBUTED"; reason: UnattributedReason; personId: string | null };

/**
 * Who gets credit for one record. `identities` maps a Google account id to the login that linked it
 * themselves.
 */
export function decideAttribution(record: DriveActivityRecord, context: { bridge: IdentityBridge; identities: ReadonlyMap<string, string> }): AttributionDecision {
  if (record.actors.length === 0) return { attribution: "UNATTRIBUTED", reason: "OTHER", personId: null };
  if (record.actors.length > 1) return { attribution: "UNATTRIBUTED", reason: "SEVERAL_ACTORS", personId: null };
  const actor = record.actors[0]!;
  switch (actor.kind) {
    case "KNOWN_USER":
      break;
    case "DELETED_USER":
    case "UNKNOWN_USER":
    case "ANONYMOUS":
    case "IMPERSONATION":
    case "SYSTEM":
    case "ADMINISTRATOR":
      return { attribution: "UNATTRIBUTED", reason: actor.kind, personId: null };
    default:
      return { attribution: "UNATTRIBUTED", reason: "OTHER", personId: null };
  }
  if (!actor.personId) return { attribution: "UNATTRIBUTED", reason: "UNKNOWN_USER", personId: null };
  if (context.bridge === "MISMATCH") return { attribution: "UNATTRIBUTED", reason: "BRIDGE_MISMATCH", personId: actor.personId };
  if (context.bridge !== "VERIFIED") return { attribution: "UNATTRIBUTED", reason: "BRIDGE_UNVERIFIED", personId: actor.personId };
  const userId = context.identities.get(actor.personId);
  if (!userId) return { attribution: "UNATTRIBUTED", reason: "NO_LINKED_IDENTITY", personId: actor.personId };
  return { attribution: "ATTRIBUTED", userId, personId: actor.personId };
}

/**
 * The connected account an echo would have come from: the account reading the record (its own
 * change, `isCurrentUser`), or — once the bridge is verified — any connected account whose sign-in
 * id Google named. Null when the actor is not one of the project's connected accounts.
 */
export function echoAccountCandidate(
  record: DriveActivityRecord,
  context: { pollingAccountId: string; bridge: IdentityBridge; accountsBySubject: ReadonlyMap<string, string> },
): string | null {
  if (record.actors.length !== 1) return null;
  const actor = record.actors[0]!;
  if (actor.kind !== "KNOWN_USER") return null;
  if (actor.isCurrentUser) return context.pollingAccountId;
  if (context.bridge === "VERIFIED" && actor.personId) return context.accountsBySubject.get(actor.personId) ?? null;
  return null;
}
