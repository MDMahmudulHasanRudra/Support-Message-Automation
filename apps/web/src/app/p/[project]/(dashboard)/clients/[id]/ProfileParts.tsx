import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  CalendarPlus,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Tag,
  Upload,
  UserPlus,
  Users,
  XCircle,
  Activity as ActivityIcon,
} from "lucide-react";
import Link from "@/components/ProjectLink";

/**
 * Presentational pieces of the client profile (CLIENTS_V3.md §1): the fact cards, the cards' header,
 * label/value rows and the tab bar. No data access and no client state — the page passes everything in.
 */

export type Accent = "blue" | "green" | "amber" | "indigo" | "red" | "slate";

export const ACCENT: Record<Accent, string> = {
  blue: "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
  green: "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
  amber: "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  indigo: "bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]",
  red: "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]",
  slate: "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]",
};

export const panel = "rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)]";
export const muted = "text-[color:var(--color-muted-foreground)]";

export function FactCard({ icon: Icon, accent, label, value, sub, valueClass = "" }: { icon: LucideIcon; accent: Accent; label: string; value: string; sub?: string | null; valueClass?: string }) {
  return (
    <div className={`${panel} flex min-w-0 items-center gap-3 px-3.5 py-3.5`}>
      <span className={`hidden size-10 shrink-0 sm:flex items-center justify-center rounded-[var(--radius-lg)] ${ACCENT[accent]}`}>
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className={`text-xs ${muted}`}>{label}</p>
        <p className={`line-clamp-2 break-words text-[15px] font-semibold leading-snug ${valueClass}`} title={value}>
          {value}
        </p>
        {sub ? (
          <p className={`truncate text-xs ${muted}`} title={sub}>
            {sub}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function SectionCard({ icon: Icon, title, action, children, className = "" }: { icon: LucideIcon; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${panel} flex min-w-0 flex-col p-5 ${className}`}>
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Icon className={`size-4 ${muted}`} aria-hidden />
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A small secondary link-button for card headers ("Edit", "View all", "Manage"). */
export function CardLink({ href, children, icon: Icon }: { href: string; children: ReactNode; icon?: LucideIcon }) {
  return (
    <Link
      href={href}
      scroll={false}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-xs font-medium shadow-[var(--shadow-xs)] hover:bg-[var(--color-neutral-bg)]"
    >
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
    </Link>
  );
}

export function InfoRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_8.5rem_1fr] items-start gap-2 border-b border-[var(--color-border)] py-2.5 text-sm last:border-b-0">
      <Icon className={`mt-0.5 size-4 ${muted}`} aria-hidden />
      <span className={muted}>{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export interface TabSpec {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
}

/** Tabs are URL state (`?tab=`), like every other panel in this app: a tab can be bookmarked and survives a refresh. */
export function ProfileTabs({ base, tabs, active }: { base: string; tabs: TabSpec[]; active: string }) {
  return (
    <nav aria-label="Client sections" className="-mx-1 overflow-x-auto overflow-y-hidden border-b border-[var(--color-border)]">
      <ul className="flex min-w-max gap-1 px-1">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <li key={t.id}>
              <Link
                href={t.id === "overview" ? base : `${base}?tab=${t.id}`}
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3.5 py-3 text-sm font-medium transition-colors ${
                  on ? "border-[var(--color-accent)] text-[color:var(--color-accent-fg)]" : `border-transparent ${muted} hover:text-[color:var(--color-foreground)]`
                }`}
              >
                <t.icon className="size-4" aria-hidden />
                {t.label}
                {t.count ? <span className="rounded-full bg-[var(--color-neutral-bg)] px-1.5 text-[11px] tabular-nums">{t.count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ACTIVITY_ICON: Record<string, [LucideIcon, Accent]> = {
  CREATED: [UserPlus, "green"],
  UPDATED: [Pencil, "slate"],
  STATUS_CHANGED: [ActivityIcon, "amber"],
  ASSIGNED: [Users, "indigo"],
  TAGS_CHANGED: [Tag, "indigo"],
  NOTE_ADDED: [FileText, "slate"],
  CHANNEL_ADDED: [Link2, "blue"],
  CHANNEL_REMOVED: [XCircle, "slate"],
  CONSENT_CHANGED: [Pencil, "slate"],
  ARCHIVED: [Archive, "slate"],
  RESTORED: [RotateCcw, "green"],
  IMPORTED: [Upload, "blue"],
  IMPORT_UPDATED: [Upload, "blue"],
  BILLING_CHANGED: [FileText, "green"],
  PAYMENT_RECORDED: [CreditCard, "green"],
  PAYMENT_REVERSED: [CreditCard, "red"],
  SUBSCRIPTION_ADDED: [CalendarPlus, "blue"],
  SUBSCRIPTION_CANCELLED: [XCircle, "red"],
  GROUP_LINKED: [MessageSquare, "green"],
  GROUP_UNLINKED: [MessageSquare, "slate"],
  CHAT_LINKED: [MessageSquare, "green"],
  CHAT_UNLINKED: [MessageSquare, "slate"],
  PHOTO_CHANGED: [ImageIcon, "slate"],
  PHOTO_REMOVED: [ImageIcon, "slate"],
};

export function ActivityItem({ type, summary, meta }: { type: string; summary: string; meta: string }) {
  const [Icon, accent] = ACTIVITY_ICON[type] ?? [ActivityIcon, "slate" as Accent];
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className={`relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ${ACCENT[accent]}`}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm">{summary}</p>
        <p className={`text-xs ${muted}`}>{meta}</p>
      </div>
    </li>
  );
}

/** The vertical rule behind a list of ActivityItems. */
export function Timeline({ children }: { children: ReactNode }) {
  return <ol className="relative before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-[var(--color-border)]">{children}</ol>;
}

/** "BD" → 🇧🇩. Windows shows the two letters instead, which still reads correctly. */
export function flagOf(code: string | null | undefined): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "BDT" → "Bangladeshi Taka", or null when the runtime does not know it. */
export function currencyName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "currency" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}
