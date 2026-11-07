import { Check, ExternalLink, Plus, Settings2, TriangleAlert } from "lucide-react";
import { Badge, ButtonLink, Card, PageHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { widgetScriptUrl } from "@/server/channels/webchat";
import { presenceFor } from "@/server/channels/webchatPresence";
import { seenInLastWeek } from "@/server/websiteChat";
import { parseWidgetSettings } from "@support-automation/shared";
import { AllowSiteButton, CopyLine } from "./WidgetTools";

export const metadata = { title: "Widgets & install" };

/** Every widget, what it takes to put it on a website, and whether it got there. */
export default async function WebsiteChatWidgetsPage() {
  const { canManage } = await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  const widgets = await prisma.channelConnection.findMany({
    where: { type: "WEBCHAT", status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, enabled: true, webhookKey: true, allowedOrigins: true, widgetSettings: true, widgetSeenAt: true, widgetSeenOrigin: true, widgetRefusedOrigin: true, aiAutomationEnabled: true },
  });
  const script = await widgetScriptUrl();
  const origin = script ? new URL(script).origin : "";

  return (
    <div>
      <PageHeader
        title="Widgets & install"
        description="One widget per website or customer: each has its own code, link, look and conversations."
        actions={
          canManage ? (
            <ButtonLink href="/website-chat/widgets/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              New widget
            </ButtonLink>
          ) : undefined
        }
      />
      {widgets.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-[color:var(--color-muted-foreground)]">No widget yet. Create one, then paste its one line of code into your website.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {widgets.map((w) => {
            const settings = parseWidgetSettings(w.widgetSettings);
            const code = script ? `<script src="${script}" data-key="${w.webhookKey}" async></script>` : "";
            const installed = seenInLastWeek(w.widgetSeenAt);
            const online = presenceFor([w.id]).online;
            return (
              <Card key={w.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                      {w.name}
                      <Badge color={w.enabled ? "green" : "gray"} dot>
                        {w.enabled ? "On" : "Off"}
                      </Badge>
                      {w.aiAutomationEnabled ? <Badge color="blue">AI answers on</Badge> : null}
                      {settings.prechat.enabled ? <Badge color="blue">Chat form on</Badge> : null}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-[color:var(--color-muted-foreground)]">{settings.allowAnyWebsite ? "Runs on any website" : w.allowedOrigins.join(", ") || "No website listed"}</p>
                  </div>
                  <ButtonLink href={`/website-chat/widgets/${w.id}`} variant="secondary">
                    <Settings2 className="size-4" aria-hidden />
                    Design & settings
                  </ButtonLink>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="min-w-0">
                    <p className="mb-1.5 text-[13px] font-medium">Paste this into your website</p>
                    <CopyLine value={code} label="Copy code" />
                    <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">Just before the closing &lt;/body&gt; tag, or in a Custom HTML block. Works on any site: WordPress, WooCommerce, Shopify, Wix, Webflow, or your own code.</p>
                  </div>
                  <div className="min-w-0">
                    <p className="mb-1.5 text-[13px] font-medium">No website? Share this chat link</p>
                    {settings.directLink ? (
                      <>
                        <CopyLine value={`${origin}/c/${w.webhookKey}`} label="Copy link" />
                        <a href={`${origin}/c/${w.webhookKey}`} target="_blank" rel="noreferrer" className="link mt-1.5 inline-flex items-center gap-1 text-xs">
                          Open it <ExternalLink className="size-3" aria-hidden />
                        </a>
                      </>
                    ) : (
                      <p className="text-xs text-[color:var(--color-muted-foreground)]">Switched off for this widget.</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-3 text-[13px]">
                  {installed ? (
                    <span className="inline-flex items-center gap-1.5 text-[color:var(--color-success-fg)]">
                      <Check className="size-4" aria-hidden /> Working on {w.widgetSeenOrigin}
                    </span>
                  ) : (
                    <span className="text-[color:var(--color-muted-foreground)]">Not seen on a website yet. Paste the code, then open your site once.</span>
                  )}
                  {settings.visitorPresence ? <span className="text-[color:var(--color-muted-foreground)]">{online} on the site now</span> : null}
                  {w.widgetRefusedOrigin ? (
                    <span className="inline-flex flex-wrap items-center gap-2 text-[color:var(--color-warning-fg)]">
                      <TriangleAlert className="size-4" aria-hidden />
                      {w.widgetRefusedOrigin} tried to use this widget
                      {canManage ? <AllowSiteButton id={w.id} /> : null}
                    </span>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
