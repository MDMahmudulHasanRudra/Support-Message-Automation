"use client";

import { ChevronRight, MessagesSquare, Smartphone, Star } from "lucide-react";
import { useEffect } from "react";
import Link, { useProjectRouter } from "@/components/ProjectLink";
import type { ChatAccountOption } from "@/server/chatInbox";
import { accountStatusTone, lastChatAccount } from "./chatAccounts";

/**
 * Pick the WhatsApp account to work in. Shown only when a project has several (one account opens
 * directly). Forwards to the account last used in this browser when it is still one of these — the
 * choice is made once, not on every visit — and otherwise waits for an explicit choice, because a
 * reply always goes out from the chosen account and guessing it is how a message leaves from the
 * wrong number.
 */
export function ChatAccountChooser({ accounts }: { accounts: ChatAccountOption[] }) {
  const router = useProjectRouter();

  useEffect(() => {
    const last = lastChatAccount();
    if (last && accounts.some((a) => a.id === last)) router.replace(`/chat/account/${last}`);
  }, [accounts, router]);

  return (
    <div className="flex h-[calc(100dvh_-_var(--chat-inset,6.75rem))] min-h-[30rem] items-center justify-center overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xs),var(--highlight-top)] sm:h-[calc(100dvh_-_var(--chat-inset-sm,8.25rem))]">
      <div className="w-full max-w-md">
        <span
          aria-hidden
          className="mx-auto flex size-11 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-subtle-foreground)] shadow-[var(--shadow-xs),var(--highlight-top)]"
        >
          <MessagesSquare className="size-5" />
        </span>
        <h1 className="mt-4 text-center text-[16px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
          {accounts.length === 0 ? "No WhatsApp account yet" : "Choose a WhatsApp account"}
        </h1>
        <p className="mx-auto mt-2 max-w-[42ch] text-center text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          {accounts.length === 0
            ? "Link a number on WhatsApp Accounts and run a group sync; its conversations will appear here."
            : "The inbox shows one account at a time, and every reply you send goes out from the account you choose here. You can switch at any time from the top of the inbox."}
        </p>

        {accounts.length === 0 ? (
          <div className="mt-5 text-center">
            <Link href="/accounts" className="link text-[13px]">
              Open WhatsApp Accounts
            </Link>
          </div>
        ) : (
          <ul className="mt-6 flex flex-col gap-2">
            {accounts.map((account) => {
              const tone = accountStatusTone(account.status);
              return (
                <li key={account.id}>
                  <Link
                    href={`/chat/account/${account.id}`}
                    className="group flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-xs)] transition-[border-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-sm)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]">
                      <Smartphone className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[14px] font-semibold text-[color:var(--color-foreground)]">
                        <span className="truncate">{account.label}</span>
                        {account.isPrimary ? <Star className="size-3 shrink-0 fill-current text-[color:var(--color-warning)]" aria-label="Primary" /> : null}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-[color:var(--color-muted-foreground)]">
                        <span className="inline-flex items-center gap-1">
                          <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden />
                          {tone.label}
                        </span>
                        {account.phoneNumber ? <span className="tabular">+{account.phoneNumber.replace(/^\+/, "")}</span> : null}
                        <span className="tabular">{account.groupCount.toLocaleString("en-US")} groups</span>
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-[color:var(--color-subtle-foreground)] transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
