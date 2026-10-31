import { META_SOCIAL_SCOPES, SOCIAL_META_CALLBACK_PATH } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { publicOrigin } from "@/server/google/oauth";
import { getMediaStorage } from "@/server/mediaStorage";
import { socialMetaReadiness } from "@/server/social/metaConnect";
import { mediaUsage } from "@/server/social/media";
import { formatBytes } from "../../social/socialUi";

export const metadata = { title: "Social Publishing settings" };

/**
 * Whether Social Studio can publish from this server (SOCIAL_STUDIO.md §Setup), and what each part needs.
 * Read-only: everything here is server configuration a platform administrator sets; this page says which
 * piece is missing — by name, never by value.
 */
export default async function SocialSettingsPage() {
  await requireAccess("social.manage", "SOCIAL_STUDIO");
  const [ready, usage] = await Promise.all([activeProjectId().then((id) => socialMetaReadiness(id)), mediaUsage()]);
  const origin = publicOrigin();
  const storage = Boolean(getMediaStorage());
  const signing = Boolean(process.env.SOCIAL_MEDIA_URL_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim());
  const processorOn = process.env.SOCIAL_PROCESSOR_DISABLED !== "true";
  const checks: Array<{ ok: boolean; label: string; fix: string }> = [
    { ok: ready.ok, label: "Meta app and this workspace", fix: ready.ok ? "" : ready.problems.join(" ") },
    { ok: Boolean(origin?.startsWith("https://")), label: "A public https address (NEXTAUTH_URL)", fix: "Meta fetches photos and videos from this address, so it must be https and reachable from the internet." },
    { ok: storage, label: "Media storage (MEDIA_STORAGE_DIR)", fix: "The media library keeps files on the media volume." },
    { ok: signing, label: "A secret for signed media addresses", fix: "Set SOCIAL_MEDIA_URL_SECRET (32+ characters) or NEXTAUTH_SECRET." },
    { ok: processorOn, label: "The publishing worker", fix: "SOCIAL_PROCESSOR_DISABLED=true is set; scheduled posts will not publish." },
  ];
  return (
    <div>
      <PageHeader title="Social Publishing" description="What Social Studio needs from this server, and whether each piece is in place." />
      <section className="mb-6">
        <SectionHeader title="Readiness" />
        <Card>
          <ul className="divide-y divide-[var(--color-border)] text-sm">
            {checks.map((c) => (
              <li key={c.label} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 font-semibold ${c.ok ? "text-[color:var(--color-success-fg)]" : "text-[color:var(--color-danger)]"}`}>{c.ok ? "✓" : "✕"}</span>
                <span>
                  {c.label}
                  {!c.ok && c.fix ? <span className="block text-xs text-[color:var(--color-muted-foreground)]">{c.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
      <section className="mb-6">
        <SectionHeader title="Meta app setup (platform administrator)" />
        <Card className="space-y-2 p-4 text-sm">
          <p>Add this to the platform Meta app&apos;s Facebook Login → Valid OAuth Redirect URIs (it is separate from the messaging callback):</p>
          <code className="block overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-2 text-xs">{origin ? `${origin}${SOCIAL_META_CALLBACK_PATH}` : `<NEXTAUTH_URL>${SOCIAL_META_CALLBACK_PATH}`}</code>
          <p>Permissions publishing asks for (each needs Meta App Review approval before real customers can use it): {META_SOCIAL_SCOPES.join(", ")}.</p>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">Optional: META_SOCIAL_LOGIN_CONFIG_ID — a Facebook Login for Business configuration made for these permissions.</p>
        </Card>
      </section>
      <section className="mb-6">
        <SectionHeader title="Limits" />
        <Card className="space-y-1 p-4 text-sm">
          <p>
            This project&apos;s media library: {formatBytes(usage.usedBytes)} of {formatBytes(usage.allowanceBytes)} (SOCIAL_MEDIA_PROJECT_MB).
          </p>
          <p>Photos up to 8 MB, videos up to 200 MB. Instagram takes JPEG photos only.</p>
          <p>Instagram limits API publishing per account per 24 hours; Social Studio checks the account&apos;s own quota first and waits.</p>
        </Card>
      </section>
      <p className="text-sm">
        <Link href="/social/accounts" className="link">
          Go to Social Studio → Accounts
        </Link>
      </p>
    </div>
  );
}
