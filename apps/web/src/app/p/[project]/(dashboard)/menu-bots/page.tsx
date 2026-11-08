import { MENU_BOT_CHANNEL_LABEL, MENU_BOT_TEMPLATES } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { listMenuBots } from "@/server/menuBots";
import Link from "@/components/ProjectLink";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { NewMenuBotButton } from "./NewMenuBotButton";

export const metadata = { title: "Menu Bots" };

const STATUS_LABEL = { DRAFT: "Draft", ACTIVE: "On", PAUSED: "Paused" } as const;
const STATUS_COLOR = { DRAFT: "gray", ACTIVE: "green", PAUSED: "yellow" } as const;

/** Menu bots (MENU_BOTS.md): numbered menus customers answer by typing a number. */
export default async function MenuBotsPage() {
  const session = await requireAccess("automation_rules.view", "MENU_BOTS");
  const [bots, canCreate] = await Promise.all([listMenuBots(), hasPermission(session, "automation_rules.create")]);
  const templates = MENU_BOT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, language: t.language }));
  return (
    <div className="min-w-0">
      <PageHeader
        title="Menu Bots"
        description="A numbered menu customers answer by typing a number, with a hand-over to a person whenever they need one."
        actions={
          <>
            <HelpButton moduleTitle="Menu Bots">
              <HelpSection title="How it answers">
                <p>A customer sends one of the bot&apos;s start words and gets the menu. Typing a number moves through it, 0 goes back, and 00 returns to the start. Typing agent, or getting it wrong twice, hands them to your team.</p>
              </HelpSection>
              <HelpSection title="Rules and AI come first or after?">
                <p>A customer already inside a menu is answered by the menu. A new menu only starts when no automation rule matched, so your existing rules keep working. While a menu answers, AI does not.</p>
              </HelpSection>
              <HelpSection title="Staying safe">
                <p>A menu only ever answers someone who just wrote to you, through the same limits and the same kill switch as every other automatic reply. If a person replies in the chat, the menu stops.</p>
              </HelpSection>
            </HelpButton>
            {canCreate ? <NewMenuBotButton templates={templates} /> : null}
          </>
        }
      />
      {bots.length === 0 ? (
        <Card>
          <EmptyState>No menu bots yet. Start from a ready-made template and change the wording to yours.</EmptyState>
        </Card>
      ) : (
        <ul className="space-y-2">
          {bots.map((b) => {
            const where = [b.onWhatsAppPersonal ? "WhatsApp chats" : null, b.onWhatsAppGroups ? "WhatsApp groups" : null, ...b.channels.map((c) => MENU_BOT_CHANNEL_LABEL[c])].filter(Boolean).join(", ");
            return (
              <li key={b.id}>
                <Card className="relative p-3.5 transition-colors hover:border-[var(--color-border-strong)] sm:p-4">
                  <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/menu-bots/${b.id}`} className="truncate text-[14.5px] font-semibold after:absolute after:inset-0 hover:underline">
                          {b.name}
                        </Link>
                        <Badge color={STATUS_COLOR[b.status]}>{STATUS_LABEL[b.status]}</Badge>
                      </div>
                      <p className="mt-0.5 truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">
                        {where || "Nowhere yet"}
                        {b.keywords.length ? ` · Starts on: ${b.keywords.slice(0, 4).join(", ")}` : ""}
                      </p>
                    </div>
                    <p className="tabular text-[13px] text-[color:var(--color-muted-foreground)]">
                      Last 30 days: <span className="font-semibold text-[color:var(--color-foreground)]">{b.stats.started.toLocaleString("en-US")}</span> started · {b.stats.handedOff.toLocaleString("en-US")} handed over
                    </p>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
