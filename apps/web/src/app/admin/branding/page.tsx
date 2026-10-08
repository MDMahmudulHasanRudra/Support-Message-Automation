import { Alert, PageHeader } from "@/components/ui";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { getBrandingSettings } from "@/server/branding";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { BrandingEditor } from "./BrandingEditor";

export const metadata = { title: "Branding" };

/**
 * White labeling (BRANDING.md): what this installation calls itself and how it looks — the product
 * name, the sign-in page, the brand colour, the logo and the app icon. Platform-wide: every project
 * and every page shows the same brand. Anyone in the portal can look; changing it needs
 * `projects.manage` (a Main Admin), which every save action checks again on the server.
 */
export default async function BrandingPage() {
  const { canManage } = await requireMainAdminPage();
  const settings = await getBrandingSettings();

  return (
    <div>
      <PageHeader
        title="Branding"
        description="Make this installation your own: its name, sign-in page, brand colour, logo and app icon. Changes apply to every project and every page as soon as they are saved."
      />
      {canManage ? null : (
        <div className="mb-6">
          <Alert tone="info" title="View only">
            Changing the branding needs the “Manage Projects and Project Access” permission (a Main Admin).
          </Alert>
        </div>
      )}
      <BrandingEditor
        canManage={canManage}
        defaults={{ ...DEFAULT_BRANDING }}
        settings={{
          productName: settings.productName,
          loginHeadline: settings.loginHeadline,
          loginSubheading: settings.loginSubheading,
          accentColor: settings.accentColor,
          logoUrl: settings.logoUrl,
          iconUrl: settings.iconUrl,
          updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
          updatedByUsername: settings.updatedByUsername,
        }}
      />
    </div>
  );
}
