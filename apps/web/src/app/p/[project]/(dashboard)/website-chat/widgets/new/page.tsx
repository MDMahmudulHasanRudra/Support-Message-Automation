import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { projectPath } from "@/server/projectPaths";
import { pageAccess } from "@/server/authorize";
import { ConnectChannelForm } from "../../../settings/channels/ConnectChannelForm";

export const metadata = { title: "New widget" };

const STEPS = [
  ["Name it and list the website", "One widget per website or customer, so each one's chats stay separate."],
  ["Design it", "Colours, logo, chat form and greeting, with a live preview on computer and phone."],
  ["Paste one line of code", "On any website. It starts working straight away, and there is a chat link if there is no website."],
];

/** Creating a widget: a name and a website, then straight to designing it. */
export default async function NewWidgetPage() {
  const { canManage } = await pageAccess("channels.view", "channels.manage", "OMNICHANNEL");
  if (!canManage) redirect(await projectPath("/website-chat/widgets"));
  return (
    <div>
      <PageHeader title="New widget" description="Takes about a minute. No outside account or password needed." />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <ConnectChannelForm type="WEBCHAT" />
        </Card>
        <Card>
          <h2 className="text-sm font-semibold">What happens next</h2>
          <ol className="mt-3 space-y-3">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-xs font-semibold text-[color:var(--color-accent-fg)]">{i + 1}</span>
                <span>
                  <span className="block text-[13px] font-medium">{title}</span>
                  <span className="block text-xs text-[color:var(--color-muted-foreground)]">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
