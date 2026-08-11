"use client";

import { useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const DECISIONS = ["IGNORE", "AUTO_REPLY", "SUPPORT_REQUIRED", "STOPPED", "ACTIONED", "NO_MATCH"] as const;
const AUTO_REPLY_STATUSES = ["PENDING", "PROCESSING", "SENT", "FAILED", "CANCELLED", "RATE_LIMITED", "SKIPPED"] as const;
const NOTIFICATION_STATUSES = ["PENDING", "SENT", "FAILED", "RETRYING"] as const;

export interface FilterOptions {
  accounts: Array<{ id: string; label: string }>;
  rules: Array<{ id: string; name: string }>;
}

export interface MessageFilters {
  accountId?: string;
  group?: string;
  sender?: string;
  dateFrom?: string;
  dateTo?: string;
  decision?: string;
  ruleId?: string;
  autoReplyStatus?: string;
  notificationStatus?: string;
}

export function MessagesFilterBar({ defaults, options }: { defaults: MessageFilters; options: FilterOptions }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const hasActiveFilters = Object.values(defaults).some(Boolean);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const qs = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim()) qs.set(key, value.trim());
    }
    startTransition(() => router.push(`/messages?${qs.toString()}`));
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 flex flex-wrap items-end gap-2 text-sm">
      <Field label="Account">
        <select name="accountId" defaultValue={defaults.accountId ?? ""} className={inputClass}>
          <option value="">All accounts</option>
          {options.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Group">
        <input name="group" placeholder="Group name contains…" defaultValue={defaults.group ?? ""} className={inputClass} />
      </Field>
      <Field label="Sender">
        <input name="sender" placeholder="Phone or name…" defaultValue={defaults.sender ?? ""} className={inputClass} />
      </Field>
      <Field label="From">
        <input name="dateFrom" type="date" defaultValue={defaults.dateFrom ?? ""} className={inputClass} />
      </Field>
      <Field label="To">
        <input name="dateTo" type="date" defaultValue={defaults.dateTo ?? ""} className={inputClass} />
      </Field>
      <Field label="Decision">
        <select name="decision" defaultValue={defaults.decision ?? ""} className={inputClass}>
          <option value="">All</option>
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rule">
        <select name="ruleId" defaultValue={defaults.ruleId ?? ""} className={inputClass}>
          <option value="">All</option>
          {options.rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Auto-Reply Status">
        <select name="autoReplyStatus" defaultValue={defaults.autoReplyStatus ?? ""} className={inputClass}>
          <option value="">All</option>
          {AUTO_REPLY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notification Status">
        <select name="notificationStatus" defaultValue={defaults.notificationStatus ?? ""} className={inputClass}>
          <option value="">All</option>
          {NOTIFICATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {isPending ? "Filtering…" : "Filter"}
      </button>
      {hasActiveFilters ? (
        <Link href="/messages" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">
          Clear Filters
        </Link>
      ) : null}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
      {label}
      {children}
    </label>
  );
}

const inputClass = "rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
