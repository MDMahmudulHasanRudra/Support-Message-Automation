import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ExternalLink, MessageCircle, Pencil, Users } from "lucide-react";
import { clientDisplayName, whatsappClickToChatUrl } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { clientWhatsAppRoute } from "@/server/clientMessages";
import Link from "@/components/ProjectLink";
import { Alert, ButtonLink, Card } from "@/components/ui";
import { groupChatHref } from "@/lib/clientDisplay";
import { LinkFoundChatButton } from "./LinkFoundChat";

export const metadata = { title: "Open WhatsApp" };

/**
 * "Open WhatsApp" for a client (CLIENT_CRM_V7.md §2), best route first:
 *   A. a linked personal conversation → straight into this project's WhatsApp Chat, where the ordinary composer replies;
 *   B. an existing conversation with the client's exact number on one of this project's accounts, not linked to anyone
 *      → offered to an admin to confirm and link (never linked automatically; an ambiguous match is not offered);
 *   C. a usable number and no conversation → WhatsApp's own click-to-chat, clearly external: Get Assist does not start
 *      conversations, and opening the link sends nothing;
 *   D. no usable number → say so, and where to fix it.
 */
export default async function ClientWhatsAppPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("clients.view");
  const { id } = await params;
  const client = await prisma.client.findFirst({
    where: { id },
    select: { id: true, name: true, companyName: true, status: true, groupLinks: { where: { unlinkedAt: null }, select: { accountId: true, groupId: true, groupName: true }, take: 3 }, channels: { where: { kind: { in: ["WHATSAPP", "PHONE"] } }, select: { normalizedValue: true } } },
  });
  if (!client) notFound();
  const [route, canOpenChat, canLink, canUpdate] = await Promise.all([
    clientWhatsAppRoute(client.id),
    hasPermission(session, "messages.view"),
    hasPermission(session, "clients.link_whatsapp_chat"),
    hasPermission(session, "clients.update"),
  ]);
  // A — the linked conversation.
  if (route.linkedChatHref && canOpenChat) redirect(await projectPath(route.linkedChatHref));

  // B — an existing, unlinked conversation with exactly this client's number. Only a single, unambiguous match is offered.
  const candidates = [...new Set(client.channels.map((c) => c.normalizedValue.replace(/\D/g, "")).filter((d) => d.length >= 8))].map((d) => `${d}@c.us`);
  const found = candidates.length
    ? await prisma.message.groupBy({ by: ["accountId", "chatId"], where: { groupId: null, chatId: { in: candidates } }, _max: { timestampWa: true }, orderBy: { _max: { timestampWa: "desc" } }, take: 5 })
    : [];
  const linkedElsewhere = found.length
    ? await prisma.clientWhatsAppChatLink.findMany({ where: { unlinkedAt: null, OR: found.map((f) => ({ accountId: f.accountId, chatId: f.chatId })) }, select: { accountId: true, chatId: true, clientId: true } })
    : [];
  const free = found.filter((f) => !linkedElsewhere.some((l) => l.accountId === f.accountId && l.chatId === f.chatId));
  const accounts = free.length ? await prisma.whatsAppAccount.findMany({ where: { id: { in: free.map((f) => f.accountId) } }, select: { id: true, label: true } }) : [];
  const match = free.length === 1 ? free[0]! : null;

  const name = clientDisplayName(client.name, client.companyName);
  const archived = client.status === "ARCHIVED";
  const external = route.clickToChatNumber ? whatsappClickToChatUrl(route.clickToChatNumber) : null;
  const groupHref = canOpenChat ? client.groupLinks.map((g) => groupChatHref(g.accountId, g.groupId)).find(Boolean) ?? null : null;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <ButtonLink href={`/clients/${client.id}`} variant="ghost" size="sm">
        <ArrowLeft className="size-3.5" aria-hidden /> Back to {name}
      </ButtonLink>
      <h1 className="text-[27px] font-semibold tracking-[-0.025em]">WhatsApp — {name}</h1>

      {route.linkedChatHref && !canOpenChat ? <Alert tone="info">This client has a linked WhatsApp conversation, but opening WhatsApp Chat needs the View Messages permission.</Alert> : null}

      {match && !route.linkedChatHref ? (
        <Card className="space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <MessageCircle className="size-4" aria-hidden /> A conversation with this number already exists
          </h2>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            On <span className="font-medium text-[color:var(--color-foreground)]">{accounts.find((a) => a.id === match.accountId)?.label ?? "one of this project's numbers"}</span>, last message{" "}
            {match._max.timestampWa?.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" }) ?? "—"}. It is not linked to any client. Linking it is your confirmation that this chat is this client; it is never done automatically.
          </p>
          {canLink && !archived ? (
            <LinkFoundChatButton clientId={client.id} accountId={match.accountId} chatId={match.chatId} openAfter={canOpenChat} />
          ) : (
            <p className="text-sm">{archived ? "Restore the client before linking a chat." : "Linking a chat needs the Link WhatsApp Chats permission. Ask an admin."}</p>
          )}
        </Card>
      ) : null}
      {free.length > 1 && !route.linkedChatHref ? (
        <Alert tone="info">
          This number has conversations on {free.length} of this project&apos;s WhatsApp numbers. Choose the right one on the client&apos;s{" "}
          <Link href={`/clients/${client.id}?tab=whatsapp`} className="underline">
            WhatsApp &amp; channels
          </Link>{" "}
          tab — nothing is linked automatically when the match is not unique.
        </Alert>
      ) : null}

      {external && !route.linkedChatHref ? (
        <Card className="space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <ExternalLink className="size-4" aria-hidden /> Open in WhatsApp
          </h2>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            {match || free.length ? "Or open" : "No conversation with this client is in Get Assist yet. Open"} WhatsApp on this device at +{route.clickToChatNumber}. This uses WhatsApp&apos;s own click-to-chat link: it opens WhatsApp, sends nothing, and the chat is not part of Get Assist until the client writes to one of this project&apos;s numbers.
          </p>
          <a href={external} target="_blank" rel="noopener noreferrer" className="inline-flex h-9.5 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]">
            <ExternalLink className="size-4" aria-hidden /> Open WhatsApp
          </a>
        </Card>
      ) : null}

      {!route.linkedChatHref && !external && !match ? (
        <Card className="space-y-3 p-5">
          <h2 className="font-semibold">No usable WhatsApp number</h2>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">{route.reason}</p>
          {canUpdate && !archived ? (
            <ButtonLink href={`/clients/${client.id}/edit`}>
              <Pencil className="size-4" aria-hidden /> Edit client
            </ButtonLink>
          ) : null}
        </Card>
      ) : null}

      {groupHref ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <span className="flex items-center gap-2 text-sm">
            <Users className="size-4" aria-hidden /> Linked WhatsApp group: <span className="font-medium">{client.groupLinks[0]?.groupName ?? "group"}</span>
          </span>
          <ButtonLink href={groupHref}>Open group</ButtonLink>
        </Card>
      ) : null}
    </div>
  );
}
