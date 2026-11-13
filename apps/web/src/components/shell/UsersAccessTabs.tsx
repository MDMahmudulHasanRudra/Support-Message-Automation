"use client";

import NextLink from "next/link";
import { LayoutGrid, ShieldCheck, UserCog } from "lucide-react";
import { workspaceOpenHref } from "@/lib/workspace";

export type UsersAccessTab = "overview" | "users" | "roles";

/**
 * Main Admin → Users & Access is three pages in two places: the portal's own overview (/admin/users) and the
 * project portal's All Users and Roles & Permissions, opened without project tabs. One tab strip on all three,
 * so each is one press from the others and it is plain they belong together. Presentation only: every page
 * still checks its own permission.
 */
export function UsersAccessTabs({ active, canViewRoles = true }: { active: UsersAccessTab; canViewRoles?: boolean }) {
  const tabs = [
    { key: "overview" as const, href: "/admin/users", label: "Overview", icon: LayoutGrid },
    { key: "users" as const, href: workspaceOpenHref("/users"), label: "All Users", icon: UserCog },
    ...(canViewRoles ? [{ key: "roles" as const, href: workspaceOpenHref("/permissions"), label: "Roles & Permissions", icon: ShieldCheck }] : []),
  ];
  return (
    <nav aria-label="Users & Access" className="-mt-2 mb-6 overflow-x-auto border-b border-[var(--color-border)]">
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const on = tab.key === active;
          const Icon = tab.icon;
          return (
            <li key={tab.key}>
              <NextLink
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={`relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors duration-[var(--duration-fast)] ${
                  on
                    ? "border-[var(--color-accent)] font-medium text-[color:var(--color-foreground)]"
                    : "border-transparent text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
                }`}
              >
                <Icon className={`size-3.5 ${on ? "text-[color:var(--color-accent)]" : ""}`} aria-hidden />
                {tab.label}
              </NextLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Which Users & Access tab a list page is, or null (forms and detail pages keep their own back link). */
export function usersAccessTabFor(path: string): UsersAccessTab | null {
  if (path === "/admin/users") return "overview";
  if (path === "/users") return "users";
  if (path === "/permissions") return "roles";
  return null;
}
