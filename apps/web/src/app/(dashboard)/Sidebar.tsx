"use client";

import { Badge } from "@/components/ui";
import {
  AlertCircle,
  Bell,
  BookOpen,
  Terminal as ConsoleIcon,
  Cpu,
  EyeOff,
  FlaskConical,
  History,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessagesSquare,
  Power,
  Send,
  Settings as SettingsIcon,
  Smartphone,
  Sparkles,
  UserPlus,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  links: NavLink[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    links: [{ href: "/overview", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "WhatsApp",
    links: [
      { href: "/accounts", label: "WhatsApp Accounts", icon: Smartphone },
      { href: "/groups", label: "Groups", icon: Users },
      { href: "/team-members", label: "Internal Team Members", icon: UserCog },
    ],
  },
  {
    label: "Messaging",
    links: [
      { href: "/messages", label: "All Messages", icon: MessagesSquare },
      { href: "/messages?decision=SUPPORT_REQUIRED", label: "Needs Attention", icon: AlertCircle },
      { href: "/messages?decision=IGNORE", label: "Ignored Messages", icon: EyeOff },
    ],
  },
  {
    label: "Automation",
    links: [
      { href: "/rules", label: "Automation Rules", icon: ListChecks },
      { href: "/rules/tester", label: "Rule Tester", icon: FlaskConical },
      { href: "/automation-control", label: "Automation Control", icon: Power },
    ],
  },
  {
    label: "Broadcast",
    links: [
      { href: "/group-message-sender", label: "Group Message Sender", icon: Send },
      { href: "/group-message-sender/history", label: "Broadcast History", icon: History },
      { href: "/group-member-adder", label: "Add Number to Groups", icon: UserPlus },
    ],
  },
  {
    label: "AI Learning",
    links: [
      { href: "/ai-learning", label: "AI Dashboard", icon: Sparkles },
      { href: "/ai-learning/knowledge-base", label: "Knowledge Base", icon: BookOpen },
      { href: "/ai-learning/providers", label: "AI Providers", icon: KeyRound },
      { href: "/ai-learning/models", label: "AI Models", icon: Cpu },
      { href: "/ai-learning/settings", label: "AI Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/notifications", label: "Notifications", icon: Bell },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
      { href: "/logs", label: "System Logs", icon: ConsoleIcon },
    ],
  },
];

function isNavActive(pathname: string, search: URLSearchParams, href: string) {
  const [hrefPath, hrefQuery = ""] = href.split("?");
  if (hrefPath !== pathname) return false;
  const hrefDecision = new URLSearchParams(hrefQuery).get("decision");
  return hrefDecision === search.get("decision");
}

export function Sidebar({
  username,
  automationEnabled,
  automationMode,
  onLogout,
}: {
  username: string;
  automationEnabled: boolean;
  automationMode: string;
  onLogout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <aside
      style={{ width: "var(--sidebar-width)" }}
      className="flex shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="border-b border-[var(--color-border)] px-4 py-4">
        <p className="text-sm font-semibold text-[color:var(--color-foreground)]">
          Support Automation
        </p>
        <p className="mt-0.5 truncate text-xs text-[color:var(--color-muted-foreground)]">{username}</p>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.links.map((link) => {
                const active = isNavActive(pathname, searchParams, link.href);
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                      active
                        ? "bg-[var(--color-info-bg)] font-medium text-[color:var(--color-info-fg)]"
                        : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-2">
          <Badge color={automationEnabled ? "green" : "red"} dot>
            {automationEnabled ? "Enabled" : "Paused"}
          </Badge>
          <span className="text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
            {automationMode}
          </span>
        </div>
        <form action={onLogout}>
          <button
            type="submit"
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)]"
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
