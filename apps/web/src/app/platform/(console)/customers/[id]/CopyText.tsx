"use client";

import { useState } from "react";

/** A value to hand to someone: shown in full, copied with one click. */
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="break-all font-mono text-xs">{text}</code>
      <button
        type="button"
        className="cursor-pointer text-xs font-medium text-[color:var(--color-accent)] hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
