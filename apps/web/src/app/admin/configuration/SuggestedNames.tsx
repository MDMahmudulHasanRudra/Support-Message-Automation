"use client";

import { useState, useTransition } from "react";
import { Check, Plus, Sparkles } from "lucide-react";
import { useToast } from "@/components/ui";
import { useRouter } from "next/navigation";
import { quickAddDepartment, quickAddJobTitle } from "@/server/actions/configuration";

const SUGGESTIONS = {
  department: ["Customer Support", "Sales", "Accounts", "Technical", "Management", "Marketing"],
  jobTitle: ["Support Agent", "Senior Support Agent", "Team Lead", "Sales Executive", "Accountant", "Manager"],
} as const;

/**
 * Ready-made names a new organisation can add with one press each. Offered, never inserted by itself: a seeded
 * guess quietly becomes the customer's structure, so each one is the admin's own choice. Hidden once added.
 */
export function SuggestedNames({ kind, existing }: { kind: "department" | "jobTitle"; existing: string[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [added, setAdded] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const taken = new Set([...existing, ...added].map((n) => n.toLowerCase()));
  const offer = SUGGESTIONS[kind].filter((n) => !taken.has(n.toLowerCase()));
  if (offer.length === 0 && added.length === 0) return null;

  const add = (name: string) => {
    setBusy(name);
    start(async () => {
      const result = await (kind === "department" ? quickAddDepartment(name) : quickAddJobTitle(name));
      setBusy(null);
      if ("error" in result) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      setAdded((list) => [...list, name]);
      router.refresh();
    });
  };

  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] px-4 py-3">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--color-foreground)]">
        <Sparkles className="size-3.5 text-[color:var(--color-accent)]" aria-hidden />
        Quick start: add common {kind === "department" ? "departments" : "job titles"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {added.map((name) => (
          <span key={name} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-bg,var(--color-accent-bg))] px-3 py-1 text-[12.5px] text-[color:var(--color-success)]">
            <Check className="size-3.5" aria-hidden />
            {name}
          </span>
        ))}
        {offer.map((name) => (
          <button
            key={name}
            type="button"
            disabled={busy !== null}
            onClick={() => add(name)}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface)] px-3 py-1 text-[12.5px] text-[color:var(--color-foreground)] ring-1 ring-[var(--color-border)] transition-colors hover:ring-[var(--color-accent)] disabled:opacity-60"
          >
            <Plus className="size-3.5" aria-hidden />
            {busy === name ? "Adding…" : name}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-[color:var(--color-subtle-foreground)]">Press any that fit your business. You can rename or remove them later.</p>
    </div>
  );
}
