"use client";

import { useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FilterBar, Input, Select } from "@/components/ui";

const DECISIONS = ["IGNORE", "AUTO_REPLY", "SUPPORT_REQUIRED", "STOPPED", "ACTIONED", "NO_MATCH"] as const;
const AUTO_REPLY_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "CANCELLED",
  "RATE_LIMITED",
  "SKIPPED",
] as const;
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
    <form onSubmit={handleSubmit}>
      <FilterBar>
        <Field label="Account">
          <Select name="accountId" defaultValue={defaults.accountId ?? ""} className="w-40">
            <option value="">All accounts</option>
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Group">
          <Input
            name="group"
            placeholder="Group name contains…"
            defaultValue={defaults.group ?? ""}
            className="w-44"
          />
        </Field>
        <Field label="Sender">
          <Input name="sender" placeholder="Phone or name…" defaultValue={defaults.sender ?? ""} className="w-40" />
        </Field>
        <Field label="From">
          <Input name="dateFrom" type="date" defaultValue={defaults.dateFrom ?? ""} className="w-36" />
        </Field>
        <Field label="To">
          <Input name="dateTo" type="date" defaultValue={defaults.dateTo ?? ""} className="w-36" />
        </Field>
        <Field label="Decision">
          <Select name="decision" defaultValue={defaults.decision ?? ""} className="w-40">
            <option value="">All</option>
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Rule">
          <Select name="ruleId" defaultValue={defaults.ruleId ?? ""} className="w-40">
            <option value="">All</option>
            {options.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Auto-Reply Status">
          <Select name="autoReplyStatus" defaultValue={defaults.autoReplyStatus ?? ""} className="w-36">
            <option value="">All</option>
            {AUTO_REPLY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notification Status">
          <Select name="notificationStatus" defaultValue={defaults.notificationStatus ?? ""} className="w-36">
            <option value="">All</option>
            {NOTIFICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" loading={isPending} size="sm">
          Filter
        </Button>
        {hasActiveFilters ? (
          <Link
            href="/messages"
            className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
          >
            Clear Filters
          </Link>
        ) : null}
      </FilterBar>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[color:var(--color-muted-foreground)]">
      {label}
      {children}
    </label>
  );
}
