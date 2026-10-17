/**
 * Client ↔ WhatsApp GROUP links (CLIENTS_V3.md §8): the pure rules.
 *
 * Separate from `clientChatLinks.ts`, which links ONE-TO-ONE chats only and must keep refusing a group.
 * A group link is a person's statement that "we support this client in that existing group". It is data:
 * it does not join the group, start a session, send anything, or switch monitoring or AI on or off.
 *
 * Ownership: a WhatsApp group is owned by at most ONE client at a time (decided default — two clients
 * claiming one group is a conflict for a person to resolve, never something to allow silently). The key
 * is the WhatsApp group id, not our group row: two of our numbers in the same group hold two rows for
 * one group, and the same group must not be linked to two clients through them. One client may own
 * many groups.
 */

/** `<digits>-<digits>@g.us` or `<digits>@g.us` — WhatsApp's group domain. */
export function isWhatsAppGroupId(id: string): boolean {
  return /^[0-9][0-9-]*@g\.us$/.test(id.trim());
}

export interface LinkableGroup {
  whatsappGroupId: string;
  isActive: boolean;
  /** The account the group row belongs to. */
  accountId: string;
}

/** Why a group cannot be linked now, or null. The caller has already read it through the project-scoped client. */
export function groupLinkRefusal(group: LinkableGroup | null, accountId: string): string | null {
  if (!group) return "That group does not exist on this account.";
  if (group.accountId !== accountId) return "That group belongs to another WhatsApp account.";
  if (!isWhatsAppGroupId(group.whatsappGroupId)) return "Only a WhatsApp group can be linked here.";
  if (!group.isActive) return "This number is no longer in that group (it is inactive). Only a group the number is currently in can be linked.";
  return null;
}

/**
 * A later group sync that cannot see the group (a short read, a phone still copying chats) never
 * removes a link: a link is unlinked only by a person. The list shows it as "group inactive" instead.
 */
export function describeGroupLinkHealth(group: { isActive: boolean } | null, accountStatus: string | null): { tone: "ok" | "warn" | "muted"; text: string } {
  if (!group) return { tone: "muted", text: "Group no longer listed" };
  if (!group.isActive) return { tone: "warn", text: "Group inactive on this number" };
  if (accountStatus && accountStatus !== "CONNECTED") return { tone: "warn", text: "Account not connected" };
  return { tone: "ok", text: "Linked" };
}

export const GROUP_LINK_LIMITS = { perClient: 50, unlinkReason: 300 } as const;
