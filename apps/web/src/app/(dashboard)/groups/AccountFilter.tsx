"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Select } from "@/components/ui";

export interface AccountFilterOption {
  /** Empty for "All accounts". */
  value: string;
  label: string;
  /** The full list URL for this choice, built on the server so it keeps search, status and page size. */
  href: string;
}

/**
 * Which WhatsApp number's groups to show — applied the moment it changes.
 *
 * It sat inside the search form, so picking an account did nothing until Search was pressed, and it
 * only appeared with two or more numbers, so a single-account deployment had no visible account
 * filter at all. Each option carries its own server-built URL, so choosing one keeps the current
 * search, status chip and page size and only resets to page 1.
 */
export function AccountFilter({ options, value }: { options: AccountFilterOption[]; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Select
      aria-label="Filter by account"
      value={value}
      disabled={pending}
      className="h-9.5 w-56"
      onChange={(event) => {
        const next = options.find((option) => option.value === event.target.value);
        if (next) startTransition(() => router.push(next.href));
      }}
    >
      {options.map((option) => (
        <option key={option.value || "all"} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
