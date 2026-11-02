import { pageAccess } from "@/server/authorize";
import { currentDocumentSettings, listDocumentSettingsVersions } from "@/server/clientDocuments";
import { Card, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { DocumentSettingsForm } from "./DocumentSettingsForm";

export const metadata = { title: "Invoice & Receipt setup" };

/**
 * Settings → Invoice & Receipt (CLIENT_CRM_V7.md §3): how this project's invoices and money receipts look — business
 * details, logo, titles, payment instructions, terms, signature, colour and paper size. Each save is a new version;
 * a document is always drawn with the version in force when it was issued.
 */
export default async function DocumentSettingsPage() {
  const { canManage } = await pageAccess("clients.manage_settings", "clients.manage_settings");
  const [current, history] = await Promise.all([currentDocumentSettings(), listDocumentSettingsVersions(10)]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Invoice & Receipt"
        description="How invoices and money receipts look when they are viewed, printed or downloaded as PDF. Saving creates a new version: documents already issued keep the version they were issued with."
      />
      {canManage ? null : <ViewOnlyNotice />}
      <DocumentSettingsForm
        canEdit={canManage}
        version={current.version}
        initial={current.value}
        hasLogo={Boolean(current.value.logoSha256)}
        hasSignature={Boolean(current.value.signatureSha256)}
      />
      <Card className="p-6">
        <h2 className="text-[15px] font-semibold">Version history</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Nothing saved yet — documents use the built-in layout with the project&apos;s name.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)] text-sm">
            {history.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">Version {v.version}</span>
                <span className="text-[color:var(--color-muted-foreground)]">
                  {v.createdByName ?? "—"} · {v.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
