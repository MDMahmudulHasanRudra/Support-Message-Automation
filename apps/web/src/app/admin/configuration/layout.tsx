import { Alert, PageHeader } from "@/components/ui";
import { requireAdminSection } from "@/server/mainAdmin";
import { ConfigurationTabs } from "./ConfigurationTabs";

export const metadata = { title: "Organization" };

/**
 * Main Admin → Configuration (MAIN_ADMIN_WORKSPACE.md §5): the organisation — departments, job titles,
 * employees. Platform data, the same whichever project you work in, so there are no project tabs.
 * `configuration.view` to look, `configuration.manage` to change; each page and action checks again.
 */
export default async function ConfigurationLayout({ children }: { children: React.ReactNode }) {
  const { allowed } = await requireAdminSection("configuration.view");
  return (
    <div>
      <PageHeader
        title="Organization"
        description="Your departments, job titles and the people who work here, shared by every project. Set them up in this order; a job title grants nothing, and access is given under Users & Access."
      />
      {allowed ? (
        <>
          <ConfigurationTabs />
          {children}
        </>
      ) : (
        <Alert tone="warning" title="Your role does not include Organization">
          It needs View Departments, Job Titles &amp; Employees. An administrator can add it to your role on Permission Modules.
        </Alert>
      )}
    </div>
  );
}
