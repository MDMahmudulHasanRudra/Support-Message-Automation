"use client";

import { useMemo, useState } from "react";
import { Alert } from "./Alert";
import { Badge } from "./Badge";
import { Checkbox, Input } from "./Field";

export interface PickableGroup {
  whatsappGroupId: string;
  name: string;
  /** Shown as a warning: alerting into a monitored group feeds the alert back in as a message. */
  isMonitored?: boolean;
}

/**
 * Choosing WhatsApp groups by name, for anywhere a setting means "send alerts here".
 *
 * Extracted from the Settings page, which had the only implementation. Everywhere else asked
 * people to type raw ids — `1234567890-1234567890@g.us` — into a textarea, one per line. Nobody
 * knows those from memory, they are copied from somewhere else and pasted, and a single wrong
 * character is a destination that silently never receives anything.
 *
 * Selections are submitted as repeated hidden inputs under one name, so the server reads them with
 * `formData.getAll(name)` — the shape the existing settings actions already expect.
 */
export function GroupPicker({
  name,
  groups,
  defaultSelected = [],
  emptyMeaning,
}: {
  /** Form field name; submitted once per selected group. */
  name: string;
  groups: PickableGroup[];
  defaultSelected?: string[];
  /** What selecting nothing means here — usually "inherit the global destination". */
  emptyMeaning?: string;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(defaultSelected));

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) => group.name.toLowerCase().includes(query));
  }, [groups, search]);

  const selectedMonitored = useMemo(
    () => groups.filter((group) => selected.has(group.whatsappGroupId) && group.isMonitored),
    [groups, selected],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      {[...selected].map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search groups by name…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-sm"
          aria-label="Search groups by name"
        />
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{selected.size} selected</span>
        {selected.size > 0 ? (
          <button
            type="button"
            className="cursor-pointer text-xs underline text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            onClick={() => setSelected(new Set())}
          >
            Clear all
          </button>
        ) : null}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {filtered.length === 0 ? (
          <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">
            {groups.length === 0 ? "No groups synced yet." : "No groups match your search."}
          </p>
        ) : (
          filtered.map((group) => (
            <label
              key={group.whatsappGroupId}
              className="flex cursor-pointer items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--color-neutral-bg)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Checkbox
                  checked={selected.has(group.whatsappGroupId)}
                  onChange={() => toggle(group.whatsappGroupId)}
                />
                <span className="min-w-0 truncate">{group.name}</span>
              </span>
              {group.isMonitored ? <Badge color="yellow">Monitored — avoid as a target</Badge> : null}
            </label>
          ))
        )}
      </div>

      {selected.size === 0 && emptyMeaning ? (
        <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">{emptyMeaning}</p>
      ) : null}

      {selectedMonitored.length > 0 ? (
        <div className="mt-2">
          <Alert tone="danger" title="Feedback-loop risk">
            {selectedMonitored.length === 1 ? "A selected group is" : "Selected groups are"} also monitored
            as a client conversation — alerts sent there are re-ingested as incoming messages. Prefer a
            dedicated internal group.
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
