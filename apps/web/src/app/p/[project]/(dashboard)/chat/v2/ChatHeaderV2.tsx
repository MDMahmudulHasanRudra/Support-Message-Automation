import { ArrowLeft, Smartphone, User, Users } from "lucide-react";
import Link from "@/components/ProjectLink";
import type { ReactNode } from "react";

/**
 * The v2 conversation header (CHAT_UI_V2.md §13): a large round avatar, the name, which number the
 * conversation belongs to, and the conversation's controls on the right. Presentation only — every
 * control passed in keeps its own checks. v1's header is untouched (the pages still render it).
 */
export function ChatHeaderV2({
  backHref,
  infoHref,
  infoTitle,
  avatar,
  isGroup,
  name,
  accountLabel,
  tone,
  detail,
  actions,
}: {
  backHref: string;
  infoHref: string;
  infoTitle: string;
  avatar: { background: string; color: string; initials: string };
  isGroup: boolean;
  name: string;
  accountLabel: string;
  tone: { dot: string; label: string };
  /** After the account chip: "10 members", or a personal chat's number. */
  detail: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 sm:gap-3 sm:px-6 sm:py-3.5">
      <Link
        href={backHref}
        aria-label="Back to conversations"
        className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] active:bg-[var(--color-neutral-bg)] md:hidden"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </Link>

      {/* The avatar and name open the info panel, as they do in WhatsApp. */}
      <Link
        href={infoHref}
        title={infoTitle}
        className="group/head flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] sm:gap-3.5"
      >
        <span
          aria-hidden
          style={{ background: avatar.background, color: avatar.color }}
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tracking-[-0.01em] shadow-[var(--highlight-top)] sm:size-12"
        >
          {isGroup ? <Users className="size-5 sm:size-6" /> : avatar.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)] group-hover/head:underline sm:text-[16px]">{name}</span>
          <span className="mt-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden text-[12px] text-[color:var(--color-muted-foreground)]">
            {/* Which number this conversation, and every reply typed below, belongs to. */}
            <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] px-1.5 py-0.5 font-medium text-[color:var(--color-neutral-fg)]">
              <Smartphone className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{accountLabel}</span>
              <span className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} title={tone.label} aria-hidden />
              <span className="sr-only">{tone.label}</span>
            </span>
            {detail}
          </span>
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">{actions}</div>
    </header>
  );
}

/** "10 members" beside the account chip. */
export function MemberCount({ count }: { count: number | null }) {
  if (count === null) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Users className="size-3.5" aria-hidden />
      {count}
      <span className="max-sm:sr-only">{count === 1 ? "member" : "members"}</span>
    </span>
  );
}

/** A personal chat says what it is, and its number when it is a phone number. */
export function PersonalDetail({ number }: { number: string | null }) {
  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1">
        <User className="size-3.5" aria-hidden />
        <span className="max-sm:sr-only">Personal chat</span>
      </span>
      {number ? <span className="tabular truncate">{number}</span> : null}
    </>
  );
}
