import { redirect } from "next/navigation";
import { getSession } from "@/server/auth";
import { currentHostScope } from "@/server/hostScope";

export default async function Home() {
  // The platform address serves the Nexora platform, not a customer's software (SAAS_PLATFORM_PLAN.md §12).
  if ((await currentHostScope()).kind === "ADMIN") redirect("/platform");
  const session = await getSession();
  redirect(session ? "/open" : "/login");
}
