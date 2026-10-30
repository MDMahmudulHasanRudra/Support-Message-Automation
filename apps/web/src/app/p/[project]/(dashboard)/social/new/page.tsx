import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { PostComposer } from "../PostComposer";
import { loadComposerChoices } from "../composerData";
import { displayZone } from "../socialUi";

export const metadata = { title: "Create post" };

/** A new Social Studio post. Saving makes a draft; publishing needs approval and a scheduler. */
export default async function NewSocialPostPage({ searchParams }: { searchParams: Promise<{ campaign?: string; date?: string; tz?: string }> }) {
  await requireAccess("social.edit", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const choices = await loadComposerChoices();
  const tz = displayZone(sp.tz);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? `${sp.date}T10:00` : "";
  return (
    <div>
      <PageHeader title="Create post" description="Write once, adjust per account, and send it for approval. Nothing is published until it is approved and scheduled." />
      <PostComposer
        initial={{
          title: "",
          content: "",
          accountIds: [],
          variants: {},
          settings: {},
          mediaIds: [],
          campaignId: choices.campaigns.some((c) => c.id === sp.campaign) ? sp.campaign! : "",
          publishMode: "SCHEDULE",
          scheduledLocal: date,
          timezone: tz,
          aiAssisted: false,
        }}
        {...choices}
      />
    </div>
  );
}
