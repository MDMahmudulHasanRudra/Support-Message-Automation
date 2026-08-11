import Link from "next/link";
import { requireSession } from "@/server/auth";
import { logout } from "@/server/actions/session";
import { prisma } from "@support-automation/db";

const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: "/overview", label: "Overview" },
  { href: "/accounts", label: "WhatsApp Accounts" },
  { href: "/groups", label: "Groups" },
  { href: "/team-members", label: "Internal Team Members" },
  { href: "/messages", label: "All Messages" },
  { href: "/needs-attention", label: "Needs Attention" },
  { href: "/ignored", label: "Ignored Messages" },
  { href: "/rules", label: "Automation Rules" },
  { href: "/rules/tester", label: "Rule Tester" },
  { href: "/group-message-sender", label: "Group Message Sender" },
  { href: "/group-message-sender/history", label: "Broadcast History" },
  { href: "/automation-control", label: "Automation Control" },
  { href: "/notifications", label: "Notifications" },
  { href: "/settings", label: "Settings" },
  { href: "/logs", label: "System Logs" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const settings = await prisma.automationSettings.findUnique({ where: { id: "global" } });

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-black">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Support Automation</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{session.email}</p>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="block rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <div
            className={`mb-2 rounded-md px-3 py-2 text-center text-xs font-medium ${
              settings?.automationEnabled
                ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            AUTOMATION {settings?.automationEnabled ? "ENABLED" : "PAUSED"} · {settings?.mode ?? "SAFE_AUTO_REPLY"}
          </div>
          <form action={logout}>
            <button
              type="submit"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-8">{children}</main>
    </div>
  );
}
