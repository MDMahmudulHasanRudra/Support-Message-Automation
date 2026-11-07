"use client";

import { useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { allowRefusedOriginAction } from "@/server/actions/webchatSettings";

/** One line of text and a button that copies it: the whole of installing a widget. */
export function CopyLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 font-mono text-[12px]">{value}</code>
      <Button
        type="button"
        size="sm"
        className="shrink-0 self-center"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          });
        }}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        {copied ? "Copied" : label}
      </Button>
    </div>
  );
}

/** The website that was just refused, allowed with one press: no typing its address into a list. */
export function AllowSiteButton({ id }: { id: string }) {
  const [busy, start] = useTransition();
  const { showToast } = useToast();
  const router = useProjectRouter();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      onClick={() =>
        start(async () => {
          const result = await allowRefusedOriginAction(id);
          showToast({ tone: result.error ? "danger" : "success", title: result.error ?? result.success ?? "Done" });
          router.refresh();
        })
      }
    >
      Allow this site
    </Button>
  );
}
