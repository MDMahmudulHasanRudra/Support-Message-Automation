"use client";

import { Badge } from "@/components/ui";
import {
  AlertCircle,
  Bell,
  BookOpen,
  ClipboardCheck,
  Terminal as ConsoleIcon,
  Cpu,
  EyeOff,
  Fingerprint,
  FlaskConical,
  History,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessagesSquare,
  Power,
  Route,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Waypoints,
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
      { href: "/accounts/routing", label: "Account Routing", icon: Route },
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
    label: "Priority Support",
    links: [
      { href: "/support-escalation", label: "Dashboard", icon: ShieldAlert },
      { href: "/support-escalation/policies", label: "Policies", icon: SlidersHorizontal },
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
    label: "Conversation Learning",
    links: [
      { href: "/conversation-learning", label: "Dashboard", icon: Waypoints },
      { href: "/conversation-learning/pattern-candidates", label: "Pattern Candidates", icon: Fingerprint },
      { href: "/conversation-learning/unknown-patterns", label: "Unknown Patterns", icon: EyeOff },
      { href: "/conversation-learning/rule-proposals", label: "Rule Proposals", icon: ClipboardCheck },
      { href: "/conversation-learning/settings", label: "Learning Settings", icon: SettingsIcon },
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
      className="flex h-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]"
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-4.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[image:var(--gradient-primary)] text-sm font-bold text-[var(--color-on-primary)] shadow-[var(--shadow-sm)]">
          S
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-[color:var(--color-foreground)]">
            Support Automation
          </p>
          <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{username}</p>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2.5 py-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]/80">
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
                    className={`group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm transition-colors duration-150 ${
                      active
                        ? "bg-[var(--color-primary-soft)] font-medium text-[color:var(--color-primary)]"
                        : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                    }`}
                  >
                    {active ? (
                      <span
                        className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--color-primary)]"
                        aria-hidden
                      />
                    ) : null}
                    <Icon
                      className={`size-4 shrink-0 transition-colors ${active ? "" : "text-[color:var(--color-muted-foreground)] group-hover:text-[color:var(--color-foreground)]"}`}
                      aria-hidden
                    />
                    <span className="truncate">{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/50 px-2.5 py-2">
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
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-foreground)] transition-colors hover:border-[var(--color-danger)]/40 hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger)]"
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
