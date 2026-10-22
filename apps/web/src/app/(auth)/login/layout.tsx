import { redirect } from "next/navigation";
import { currentHostScope } from "@/server/hostScope";

/** On the platform address the software's sign-in does not exist: operators sign in on the platform (SAAS_PLATFORM_PLAN.md §12). */
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  if ((await currentHostScope()).kind === "ADMIN") redirect("/platform/login");
  return children;
}
