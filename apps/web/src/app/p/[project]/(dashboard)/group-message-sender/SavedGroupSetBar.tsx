"use client";

import { useState, useTransition } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { Button, Input, useToast } from "@/components/ui";
import {
  createSavedGroupSet,
  deleteSavedGroupSet,
  loadSavedGroupSet,
  replaceSavedGroupSet,
} from "@/server/actions/savedGroupSets";

export interface SavedGroupSetOption {
  id: string;
  name: string;
  count: number;
}

/**
 * Save the current selection, or load one saved earlier.
 *
 * Loading ADDS to the selection rather than replacing it, so two sets can be combined — "Premium
 * plus Night Shift" is a real audience and a replace would make it two separate broadcasts. Where
 * that is not wanted, Clear all sits a few pixels away and says exactly what it does.
 *
 * A saved set is a snapshot, so some of its groups may no longer exist or may have been resynced
 * away. That count is reported on load rather than swallowed: sending to eighty groups under the
 * name of a set that once meant a hundred is the failure worth being loud about.
 */
export function SavedGroupSetBar({
  accountId,
  selectedIds,
  savedSets,
  onLoad,
}: {
  accountId: string;
  selectedIds: string[];
  savedSets: SavedGroupSetOption[];
  onLoad: (groupIds: string[]) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  function load(set: SavedGroupSetOption) {
    startTransition(async () => {
      const result = await loadSavedGroupSet(set.id, accountId);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      onLoad(result.usable ?? []);
      showToast({
        tone: "success",
        title: `${result.usable?.length ?? 0} group${result.usable?.length === 1 ? "" : "s"} added from “${set.name}”`,
        description: result.missing
          ? `${result.missing} saved group${result.missing === 1 ? " is" : "s are"} no longer available on this account.`
          : undefined,
      });
    });
  }

  function save() {
    startTransition(async () => {
      const result = await createSavedGroupSet(name, selectedIds);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      setNaming(false);
      setName("");
      showToast({ tone: "success", title: `Saved “${name.trim()}”` });
    });
  }

  return (
    <div className="mb-3 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
          <Bookmark className="size-3.5" aria-hidden />
          Saved sets
        </span>

        {savedSets.length === 0 ? (
          <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
            None yet — select some groups and save them to reuse next time.
          </span>
        ) : (
          savedSets.map((set) => (
            <span key={set.id} className="flex items-center">
              <button
                type="button"
                disabled={pending}
                onClick={() => load(set)}
                className="cursor-pointer rounded-l-full border border-r-0 border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-2.5 pr-2 text-[11px] font-medium text-[color:var(--color-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
              >
                {set.name}
                <span className="ml-1.5 tabular opacity-60">{set.count}</span>
              </button>
              <button
                type="button"
                disabled={pending}
                aria-label={`Delete set ${set.name}`}
                onClick={() =>
                  startTransition(async () => {
                    await deleteSavedGroupSet(set.id);
                    showToast({ tone: "success", title: `Deleted “${set.name}”` });
                  })
                }
                className="cursor-pointer rounded-r-full border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-danger-fg)] disabled:opacity-50"
              >
                <Trash2 className="size-3" aria-hidden />
              </button>
            </span>
          ))
        )}

        {selectedIds.length > 0 && !naming ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setNaming(true)}>
            Save these {selectedIds.length}
          </Button>
        ) : null}
      </div>

      {naming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="All Premium Clients"
            maxLength={60}
            autoFocus
            className="max-w-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
          <Button size="sm" disabled={pending || !name.trim()} onClick={save}>
            Save {selectedIds.length}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Overwrites an existing set with the current selection. Exported for a future "update" control. */
export async function updateSet(id: string, groupIds: string[]) {
  return replaceSavedGroupSet(id, groupIds);
}
