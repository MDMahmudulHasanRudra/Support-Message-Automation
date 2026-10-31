"use client";

import { useState } from "react";
import { Hash } from "lucide-react";
import {
  canonicalPrefix,
  CLIENT_CODE_DEFAULT_WIDTH,
  CLIENT_CODE_MAX_WIDTH,
  CLIENT_CODE_PREFIX_MAX,
  parseSerial,
  prefixRefusal,
  previewClientCodes,
  suggestCodePrefix,
} from "@support-automation/shared";
import { Field, Input } from "@/components/ui";

export interface ClientCodeContext {
  /** The customer has no primary project yet: this one will be it (numbers only). */
  primary: boolean;
  /** Prefixes the customer's projects hold, retired ones included. */
  reserved: Array<{ prefix: string; projectName: string }>;
}

/**
 * The client code format of a new project (CLIENT_CODES.md). The prefix follows the project's name and slug until
 * somebody types one; a prefix another project of this customer holds is refused here and again on the server.
 */
export function ClientCodeFields({
  context,
  name,
  slug,
  errors,
}: {
  context: ClientCodeContext;
  name: string;
  slug: string;
  errors?: { codePrefix?: string; codeWidth?: string; codeStart?: string };
}) {
  const reserved = new Map(context.reserved.map((r) => [r.prefix, r.projectName]));
  const [typed, setTyped] = useState<string | null>(null);
  const [width, setWidth] = useState(String(CLIENT_CODE_DEFAULT_WIDTH));
  const [start, setStart] = useState("1");
  // A server refusal describes what was submitted; once the field is edited it no longer applies.
  const [seen, setSeen] = useState<typeof errors>(undefined);
  const server = errors && errors !== seen ? errors : undefined;

  const suggested = context.primary ? "" : (suggestCodePrefix({ name, slug }, new Set(reserved.keys())) ?? "");
  const prefix = context.primary ? "" : canonicalPrefix(typed ?? suggested);
  const refusal = context.primary ? null : prefix ? prefixRefusal(prefix, reserved) : "Enter a prefix: letters A–Z.";
  const widthNumber = Number(width);
  const widthOk = Number.isInteger(widthNumber) && widthNumber >= 1 && widthNumber <= CLIENT_CODE_MAX_WIDTH;
  const startSerial = parseSerial(start);
  const preview = !refusal && widthOk && startSerial ? previewClientCodes(prefix, startSerial, widthNumber) : null;
  const others = context.reserved.filter((r) => r.prefix !== "");

  return (
    <fieldset className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
      <legend className="flex items-center gap-1.5 px-1 text-[13px] font-semibold">
        <Hash className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
        Client codes
      </legend>
      {context.primary ? (
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
          This is the first project, so its client codes are numbers only. Later projects get a letter prefix of their own.
        </p>
      ) : (
        <Field
          label="Prefix"
          htmlFor="code-prefix"
          error={server?.codePrefix ?? refusal ?? undefined}
          hint={
            typed === null
              ? `Suggested from the project's name. ${others.length ? `Already reserved: ${others.slice(0, 8).map((r) => `${r.prefix} (${r.projectName})`).join(", ")}${others.length > 8 ? ` and ${others.length - 8} more` : ""}.` : ""}`.trim()
              : `Letters A–Z, up to ${CLIENT_CODE_PREFIX_MAX}. A prefix is never given to two projects, and is kept even after a change.`
          }
        >
          <Input
            id="code-prefix"
            name="codePrefix"
            value={prefix}
            onChange={(e) => (setSeen(errors), setTyped(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, CLIENT_CODE_PREFIX_MAX)))}
            autoComplete="off"
            spellCheck={false}
            className="w-40 font-mono uppercase"
            aria-describedby="code-preview"
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-4">
        <Field label="Minimum digits" htmlFor="code-width" error={server?.codeWidth ?? (widthOk ? undefined : `1 to ${CLIENT_CODE_MAX_WIDTH}`)} hint="Numbers grow past it (9999 → 10000).">
          <Input id="code-width" name="codeWidth" type="number" min={1} max={CLIENT_CODE_MAX_WIDTH} value={width} onChange={(e) => (setSeen(errors), setWidth(e.target.value))} className="w-24 tabular" />
        </Field>
        <Field label="First number" htmlFor="code-start" error={server?.codeStart ?? (startSerial ? undefined : "A whole number, at least 1")}>
          <Input id="code-start" name="codeStart" inputMode="numeric" value={start} onChange={(e) => (setSeen(errors), setStart(e.target.value.replace(/[^0-9]/g, "")))} className="w-32 tabular" />
        </Field>
      </div>
      <p id="code-preview" className="text-[12.5px]" aria-live="polite">
        {preview ? (
          <>
            New clients will be{" "}
            {preview.map((code, i) => (
              <span key={code}>
                <code className="rounded bg-[var(--color-neutral-bg)] px-1.5 py-0.5 font-mono">{code}</code>
                {i < preview.length - 1 ? ", " : ", …"}
              </span>
            ))}
          </>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">Fix the fields above to see the codes.</span>
        )}
      </p>
    </fieldset>
  );
}
