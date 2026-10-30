import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { listTemplates, recentHashtags } from "@/server/social/library";
import { TemplateForm, TemplateList } from "./TemplateEditor";

export const metadata = { title: "Social templates" };

/**
 * Reusable text for the composer (SOCIAL_STUDIO.md §Library): post templates, signatures and hashtag
 * sets, plus the hashtags this project actually used recently, counted from its own posts.
 */
export default async function SocialTemplatesPage() {
  const { canManage: canEdit } = await pageAccess("social.view", "social.edit", "SOCIAL_STUDIO");
  const [templates, topTags] = await Promise.all([listTemplates(), recentHashtags(90, 40)]);
  return (
    <div>
      <PageHeader title="Templates" description="Post templates, signatures and hashtag sets, ready to insert in the composer." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="space-y-6">
          {canEdit ? (
            <Card className="p-4">
              <SectionHeader title="Add" />
              <TemplateForm />
            </Card>
          ) : null}
          <TemplateList templates={templates.map((t) => ({ id: t.id, kind: t.kind, name: t.name, content: t.content, createdByUsername: t.createdByUsername }))} canEdit={canEdit} />
        </div>
        <aside>
          <SectionHeader title="Hashtags used" description="In this project's posts of the last 90 days." />
          <Card className="p-4">
            {topTags.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">No hashtags used yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5 text-xs">
                {topTags.map(([tag, n]) => (
                  <li key={tag} className="rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] px-1.5 py-0.5">
                    {tag} <span className="tabular text-[color:var(--color-muted-foreground)]">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
