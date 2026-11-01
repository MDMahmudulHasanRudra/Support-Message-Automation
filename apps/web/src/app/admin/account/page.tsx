import type { Metadata } from "next";
import { AccountView } from "@/components/account/AccountView";

export const metadata: Metadata = { title: "My account" };
export const dynamic = "force-dynamic";

/** My account inside the Main Admin Portal (ACCOUNT_SELF_SERVICE.md) — the same view as /account. */
export default function AdminMyAccountPage() {
  return <AccountView />;
}
