"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** The client code with a one-click copy. Clipboard access can be refused (http, a locked-down browser): then it just says so. */
export function CopyCode({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-[color:var(--color-muted-foreground)]">
      {code}
      <button
        type="button"
        title={state === "failed" ? "Copy is blocked in this browser" : "Copy client code"}
        aria-label="Copy client code"
        className="rounded p-0.5 hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setState("copied");
          } catch {
            setState("failed");
          }
          setTimeout(() => setState("idle"), 1500);
        }}
      >
        {state === "copied" ? <Check className="size-3.5 text-[color:var(--color-success-fg)]" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
