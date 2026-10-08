"use client";

import { useTransition } from "react";
import { EyeOff, X } from "lucide-react";
import { operationClearLabel, type WhatsAppOperation } from "@support-automation/shared";
import { useToast } from "@/components/ui";
import { clearOperation } from "./operationsStore";

/**
 * Clear (finished or ready for review) or Hide (still running) — removes the operation from THIS
 * person's tracker, on every page and device, and nothing more. It is deliberately quiet: a text
 * button, never the card's main action, and never a Cancel. Stopping a job is on its own page.
 */
export function ClearOperationButton({ op, size = "sm" }: { op: WhatsAppOperation; size?: "xs" | "sm" }) {
  const label = operationClearLabel(op.state);
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();
  const Icon = label === "Hide" ? EyeOff : X;

  return (
    <button
      type="button"
      disabled={pending}
      title={
        label === "Hide"
          ? "Hide from your operations. The job keeps running — Cancel it on its page if you want it stopped."
          : "Remove from your operations. The job's results stay on its page."
      }
      onClick={() =>
        startTransition(async () => {
          const result = await clearOperation(op);
          if (result.error) {
            showToast({ tone: "danger", title: result.error });
            return;
          }
          showToast({
            tone: "success",
            title: label === "Hide" ? `${op.title} hidden` : `${op.title} cleared`,
            description:
              label === "Hide"
                ? "It keeps running on the server and shows again when it needs you or finishes."
                : "Nothing was undone or deleted — its page still has every result.",
          });
        })
      }
      className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
        size === "xs" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-[13px]"
      }`}
    >
      <Icon className={size === "xs" ? "size-3" : "size-3.5"} aria-hidden />
      {label}
    </button>
  );
}
