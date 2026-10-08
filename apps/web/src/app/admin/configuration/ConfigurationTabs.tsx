"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/configuration/employees", label: "Employees" },
  { href: "/admin/configuration/departments", label: "Departments" },
  { href: "/admin/configuration/job-titles", label: "Job Titles" },
];

export function ConfigurationTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Configuration" className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <NextLink
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-[13px] transition-colors duration-[var(--duration-fast)] ${
              active
                ? "border-[var(--color-accent)] font-medium text-[color:var(--color-foreground)]"
                : "border-transparent text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            {tab.label}
          </NextLink>
        );
      })}
    </nav>
  );
}
