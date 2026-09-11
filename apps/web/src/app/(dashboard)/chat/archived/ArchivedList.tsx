"use client";

import { useState, useTransition } from "react";
import { ArchiveRestore } from "lucide-react";
import { Button, EmptyState, useToast } from "@/components/ui";
import { setChatArchived } from "@/server/actions/chatOrganisation";
import type { ConversationSummary } from "@/server/chatInbox";

/**
 * The archived list, with restore.
 *
 * Deliberately plainer than the inbox: no previews, no waiting badges, no categories. You come
 * here to find one conversation and put it back, not to triage — and the server does not fetch a
 * last-message preview for these rows at all, so showing an empty line where one usually sits
 * would read as a bug rather than a choice.
 */
export function ArchivedList({ conversations }: { conversations: ConversationSummary[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function restore(ids: string[]) {
    startTransition(async () => {
      const result = await setChatArchived(ids, false);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      const updated = result.updated ?? 0;
      showToast({
        tone: "success",
        title: `${updated} conversation${updated === 1 ? "" : "s"} back in the inbox`,
      });
      setSelected(new Set());
    });
  }

  if (conversations.length === 0) {
    return (
      <div className="flex-1 p-6">
        <EmptyState>
          Nothing archived. Use <strong>Select</strong> in the inbox to archive conversations you do not
          need to watch.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected.size > 0 ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-5 py-2">
          <span className="text-[12px] font-medium text-[color:var(--color-foreground)]">
            {selected.size} selected
          </span>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => restore([...selected])}>
            <ArchiveRestore className="size-3.5" aria-hidden />
            Restore
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="cursor-pointer text-[12px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            Clear
          </button>
        </div>
      ) : null}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {conversations.map((conversation) => {
          const isSelected = selected.has(conversation.id);
          return (
            <li key={conversation.id}>
              <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(conversation.id)) next.delete(conversation.id);
                      else next.add(conversation.id);
                      return next;
                    })
                  }
                  className={`flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] border text-[11px] font-semibold uppercase transition-colors duration-[var(--duration-fast)] ${
                    isSelected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                      : "border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]"
                  }`}
                >
                  {isSelected ? "✓" : conversation.name.slice(0, 2)}
                </button>

                <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-foreground)]">
                  {conversation.name}
                </span>

                {/* Still-live state is worth showing here: it is the reassurance that archiving
                    only hid the conversation, and the warning if somebody expected otherwise. */}
                {conversation.aiAutomationEnabled ? (
                  <span className="shrink-0 rounded-[var(--radius-xs)] bg-[var(--color-info-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-info-fg)]">
                    AI on
                  </span>
                ) : null}

                <Button size="sm" variant="ghost" disabled={pending} onClick={() => restore([conversation.id])}>
                  Restore
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
