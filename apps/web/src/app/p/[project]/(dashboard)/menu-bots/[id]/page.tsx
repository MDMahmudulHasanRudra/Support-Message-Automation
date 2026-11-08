import { notFound } from "next/navigation";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { loadMenuBot } from "@/server/menuBots";
import Link from "@/components/ProjectLink";
import { Card, StatTile } from "@/components/ui";
import { MenuBotEditor } from "./MenuBotEditor";

export const metadata = { title: "Menu Bot" };

export default async function MenuBotPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("automation_rules.view", "MENU_BOTS");
  const { id } = await params;
  const bot = await loadMenuBot(id);
  if (!bot) notFound();
  const [canEdit, canActivate, canDelete] = await Promise.all([hasPermission(session, "automation_rules.edit"), hasPermission(session, "automation_rules.activate"), hasPermission(session, "automation_rules.delete")]);
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="min-w-0">
      <div className="mb-3 text-[13px] text-[color:var(--color-muted-foreground)]">
        <Link href="/menu-bots" className="hover:underline">
          Menu Bots
        </Link>{" "}
        / {bot.name}
      </div>
      <MenuBotEditor bot={bot} canEdit={canEdit} canActivate={canActivate} canDelete={canDelete} />

      <h2 className="mb-2 mt-6 text-[14px] font-semibold">Last 30 days</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Started" value={n(bot.stats.started)} />
        <StatTile label="Choices made" value={n(bot.stats.choices)} />
        <StatTile label="Handed to a person" value={n(bot.stats.handedOff)} />
        <StatTile label="In a menu now" value={n(bot.stats.running)} />
      </div>
      {bot.topOptions.length ? (
        <Card className="mt-3 p-4">
          <h3 className="mb-2 text-[13.5px] font-semibold">Most chosen</h3>
          <ul className="space-y-1.5">
            {bot.topOptions.map((o) => (
              <li key={o.label} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">{o.label}</span>
                <span className="tabular shrink-0 text-[color:var(--color-muted-foreground)]">{n(o.count)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
