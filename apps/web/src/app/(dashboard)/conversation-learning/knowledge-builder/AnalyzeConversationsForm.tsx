"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  useToast,
} from "@/components/ui";
import { startConversationAnalysis } from "@/server/actions/knowledgeBuilder";

export interface AnalyzableGroup {
  id: string;
  name: string;
}

const MAX_GROUPS = 25;

/**
 * Pick groups, pick a window, press Analyze. Each selected group costs one AI call, which is why
 * the selection is capped and why the count is shown rather than left for somebody to discover
 * from their provider bill.
 */
export function AnalyzeConversationsForm({ groups }: { groups: AnalyzableGroup[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [rangeKind, setRangeKind] = useState("LAST_7_DAYS");
  const [messageLimit, setMessageLimit] = useState(200);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [label, setLabel] = useState("");
  const [isPending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(term));
  }, [groups, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function analyze() {
    startTransition(async () => {
      const result = await startConversationAnalysis({
        groupIds: [...selected],
        rangeKind,
        messageLimit,
        rangeStart: rangeStart || undefined,
        rangeEnd: rangeEnd || undefined,
        label,
      });
      if (!result.ok) {
        showToast({ tone: "danger", title: "Couldn't start the analysis", description: result.error });
        return;
      }
      setSelected(new Set());
      setLabel("");
      showToast({
        tone: "success",
        title: "Analysis queued",
        description: "Candidates will appear below as each group is read.",
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Time range" hint="How far back to read in each selected group.">
          <Select value={rangeKind} onChange={(e) => setRangeKind(e.target.value)}>
            <option value="LAST_24_HOURS">Last 24 hours</option>
            <option value="LAST_7_DAYS">Last 7 days</option>
            <option value="LATEST_MESSAGES">Most recent messages</option>
            <option value="CUSTOM">Custom dates</option>
          </Select>
        </Field>

        {rangeKind === "LATEST_MESSAGES" ? (
          <Field label="How many messages per group" hint="Up to 400. Counted per group, newest first.">
            <Input
              type="number"
              min={10}
              max={400}
              value={messageLimit}
              onChange={(e) => setMessageLimit(Number(e.target.value))}
            />
          </Field>
        ) : null}

        {rangeKind === "CUSTOM" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
            </Field>
            <Field label="To" hint="Optional.">
              <Input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
            </Field>
          </div>
        ) : null}

        <Field label="Name this run" hint="Optional — helps you find it later.">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. billing groups, this week"
          />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">
            Select groups{" "}
            <span className="font-normal text-[color:var(--color-muted-foreground)]">
              ({selected.size} of {MAX_GROUPS} max)
            </span>
          </p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search groups…"
            className="h-8 w-56 text-xs"
          />
        </div>

        {groups.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
            No groups with stored messages yet. Conversations have to be collected before they can
            be learned from.
          </p>
        ) : (
          <ul className="max-h-64 space-y-px overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] p-1.5">
            {visible.map((group) => {
              const isSelected = selected.has(group.id);
              const atCap = !isSelected && selected.size >= MAX_GROUPS;
              return (
                <li key={group.id}>
                  <label
                    className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-[13px] ${
                      atCap
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer hover:bg-[var(--color-neutral-bg)]/60"
                    }`}
                  >
                    <Checkbox checked={isSelected} disabled={atCap} onChange={() => toggle(group.id)} />
                    <span className="min-w-0 flex-1 truncate text-[color:var(--color-foreground)]">
                      {group.name}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
          Reads stored messages only. Nothing is sent, and nothing reaches the knowledge base until
          you approve it.
        </p>
        <Button onClick={analyze} loading={isPending} disabled={selected.size === 0}>
          <Sparkles className="size-3.5" aria-hidden />
          Analyze {selected.size > 0 ? `${selected.size} group(s)` : "conversations"}
        </Button>
      </div>
    </div>
  );
}
