import { DEFAULT_PRODUCT_NAME } from "@support-automation/shared";
import { requireOperatorPage } from "@/server/platform/auth";
import { platformLogout } from "../login/actions";
import { PlatformShell } from "./PlatformShell";

/** Every platform page: a signed-in operator on the platform address (or an open one), else the platform sign-in. */
export default async function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const operator = await requireOperatorPage();
  return (
    <PlatformShell operator={operator.username} productName={DEFAULT_PRODUCT_NAME} onLogout={platformLogout}>
      {children}
    </PlatformShell>
  );
}
