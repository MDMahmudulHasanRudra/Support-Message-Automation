"use client";

import { clientInitials } from "@support-automation/shared";
import { useProjectHref } from "@/components/ProjectLink";
import { photoPath } from "@/lib/clientDisplay";

/** Six calm tints, picked by the code so a client keeps its colour everywhere it appears. */
const TINTS = [
  "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]",
  "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]",
  "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]",
  "bg-[var(--color-secondary-bg)] text-[color:var(--color-secondary-fg)]",
  "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]",
  "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]",
];

function tintFor(code: string): string {
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** A client's photo (served by the authorised photo route), or their initials. */
export function ClientAvatar({
  id,
  code,
  name,
  companyName,
  photoVersion,
  size = "md",
}: {
  id: string;
  code: string;
  name: string;
  companyName?: string | null;
  photoVersion: number | null;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const toProject = useProjectHref();
  const path = photoPath(id, photoVersion);
  const box = size === "xl" ? "size-20 sm:size-24 text-2xl rounded-full" : size === "lg" ? "size-16 text-lg rounded-2xl" : size === "sm" ? "size-8 text-[11px] rounded-lg" : "size-10 text-[13px] rounded-xl";
  if (path) {
    // eslint-disable-next-line @next/next/no-img-element -- an authorised, per-project route; next/image would proxy it through the optimiser
    return <img src={toProject(path)} alt="" className={`${box} shrink-0 object-cover ring-1 ring-[var(--color-border)]`} loading="lazy" />;
  }
  return (
    <span aria-hidden className={`${box} ${tintFor(code)} inline-flex shrink-0 items-center justify-center font-semibold tracking-[-0.01em]`}>
      {clientInitials(name, companyName ?? null, code)}
    </span>
  );
}
