"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { contactIdentifierHref, detectContactIdentifier, normalizeContactIdentifier, type ContactIdentifierKindValue, type ContactIdentifierReading } from "@support-automation/shared";
import { Input } from "@/components/ui";
import { PasteValues, usePastedValues, type PickedValue } from "@/components/contacts/contactDisplay";

/**
 * A box per phone number, email and link, with + to add more and a short reason under a box that is not a valid value.
 * Shared by the Contact tab beside a chat and the New contact window, so both ask for a contact the same way.
 */

// ── The boxes ───────────────────────────────────────────────────────────────────────────────────

export type BoxKind = "PHONE" | "EMAIL" | "LINK";
type Row = { id: number; text: string; touched: boolean };

const BOXES: Array<{ kind: BoxKind; title: string; add: string; noun: string; placeholder: string; inputMode: "tel" | "email" | "url" }> = [
  { kind: "PHONE", title: "Phone numbers", add: "Add number", noun: "number", placeholder: "01XXXXXXXXX or +8801XXXXXXXXX", inputMode: "tel" },
  { kind: "EMAIL", title: "Emails", add: "Add email", noun: "email", placeholder: "name@example.com", inputMode: "email" },
  { kind: "LINK", title: "Social media and website links", add: "Add link", noun: "link", placeholder: "Facebook, Instagram, Telegram or website link", inputMode: "url" },
];

let nextRowId = 1;
const emptyRow = (): Row => ({ id: nextRowId++, text: "", touched: false });
const emptyBoxes = (): Record<BoxKind, Row[]> => ({ PHONE: [emptyRow()], EMAIL: [emptyRow()], LINK: [emptyRow()] });

/** How one box reads: a value, a short reason it is not one, or nothing typed. */
export function readBox(box: BoxKind, text: string, handleKind?: ContactIdentifierKindValue): ContactIdentifierReading | { error: string } | null {
  if (!text.trim()) return null;
  if (box === "PHONE") {
    const r = normalizeContactIdentifier("PHONE", text);
    return "error" in r ? { error: "This is not a phone number. Use 8 to 15 digits." } : r;
  }
  if (box === "EMAIL") {
    const r = normalizeContactIdentifier("EMAIL", text);
    return "error" in r ? { error: "This is not an email address." } : r;
  }
  const r = detectContactIdentifier(text);
  if (r && r.kind !== "OTHER") return r;
  // A bare @name says nothing about the app; this chat's own channel is the only safe guess.
  if (r && handleKind && handleKind !== "PHONE") {
    const own = normalizeContactIdentifier(handleKind, text);
    if (!("error" in own)) return own;
  }
  return { error: "This is not a link. Paste the whole address, for example facebook.com/name." };
}

export const boxOf = (kind: ContactIdentifierKindValue): BoxKind => (kind === "PHONE" ? "PHONE" : kind === "EMAIL" ? "EMAIL" : "LINK");
/** What goes back into a box for a found value: a link for an account, so the box reads it the same way again. */
export const boxText = (v: { kind: ContactIdentifierKindValue; value: string }) => (v.kind === "PHONE" || v.kind === "EMAIL" ? v.value : (contactIdentifierHref(v.kind, v.value) ?? v.value));
export const keyOf = (v: { kind: string; normalized: string }) => `${v.kind}:${v.normalized}`;

export function useValueBoxes(handleKind?: ContactIdentifierKindValue) {
  const [rows, setRows] = useState(emptyBoxes);
  const readings = (Object.keys(rows) as BoxKind[]).flatMap((box) => rows[box].map((row) => ({ box, row, read: readBox(box, row.text, handleKind) })));
  const valid = readings.flatMap((r) => (r.read && !("error" in r.read) ? [r.read] : []));
  const update = (box: BoxKind, id: number, patch: Partial<Row>) => setRows((all) => ({ ...all, [box]: all[box].map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  return {
    rows,
    readings,
    valid,
    invalid: readings.some((r) => r.read && "error" in r.read),
    taken: new Set(valid.map(keyOf)),
    update,
    addRow: (box: BoxKind) => setRows((all) => ({ ...all, [box]: [...all[box], emptyRow()] })),
    removeRow: (box: BoxKind, id: number) => setRows((all) => ({ ...all, [box]: all[box].length > 1 ? all[box].filter((r) => r.id !== id) : [emptyRow()] })),
    touchAll: () => setRows((all) => Object.fromEntries((Object.keys(all) as BoxKind[]).map((b) => [b, all[b].map((r) => ({ ...r, touched: true }))])) as Record<BoxKind, Row[]>),
    /** Puts found values into the first empty box of their kind, adding a box when every one is filled. */
    put: (values: ReadonlyArray<{ kind: ContactIdentifierKindValue; value: string }>) =>
      setRows((all) => {
        const next = { PHONE: [...all.PHONE], EMAIL: [...all.EMAIL], LINK: [...all.LINK] };
        for (const v of values) {
          const box = boxOf(v.kind);
          const empty = next[box].findIndex((r) => !r.text.trim());
          const row = { ...emptyRow(), text: boxText(v), touched: true };
          if (empty >= 0) next[box][empty] = { ...row, id: next[box][empty]!.id };
          else next[box].push(row);
        }
        return next;
      }),
    clear: () => setRows(emptyBoxes()),
  };
}
export type ValueBoxesState = ReturnType<typeof useValueBoxes>;

export function ValueBoxes({ boxes }: { boxes: ValueBoxesState }) {
  return (
    <div className="space-y-3">
      {BOXES.map((b) => {
        const rows = boxes.rows[b.kind];
        return (
          <fieldset key={b.kind} className="min-w-0">
            <legend className="mb-1.5 text-[13px] font-medium text-[color:var(--color-foreground)]">{b.title}</legend>
            <div className="space-y-1.5">
              {rows.map((row, i) => {
                const read = boxes.readings.find((r) => r.row.id === row.id)?.read;
                const error = row.touched && read && "error" in read ? read.error : null;
                const errorId = `box-${row.id}-error`;
                return (
                  <div key={row.id}>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={row.text}
                        inputMode={b.inputMode}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={rows.length > 1 ? `${b.title}, ${i + 1}` : b.title}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        placeholder={b.placeholder}
                        onChange={(e) => boxes.update(b.kind, row.id, { text: e.target.value })}
                        onBlur={() => boxes.update(b.kind, row.id, { touched: true })}
                        className={`min-w-0 flex-1 ${error ? "border-[var(--color-danger)]" : ""}`}
                      />
                      {rows.length > 1 ? (
                        <button
                          type="button"
                          aria-label={`Remove this ${b.noun}`}
                          title={`Remove this ${b.noun}`}
                          onClick={() => boxes.removeRow(b.kind, row.id)}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    {error ? (
                      <p id={errorId} className="mt-1 text-[12px] font-medium text-[color:var(--color-danger)]">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => boxes.addRow(b.kind)} className="link mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium">
              <Plus className="size-3.5" aria-hidden />
              {b.add}
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}

/** The boxes, then anything pasted in the secondary box, each value once. */
export function collectValues(boxes: ValueBoxesState, pasted: PickedValue[]): PickedValue[] {
  const seen = new Set<string>();
  const out: PickedValue[] = [];
  for (const v of [...boxes.valid.map((r) => ({ kind: r.kind, value: r.value })), ...pasted]) {
    const key = `${v.kind}:${v.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function PasteSeveral({ paste }: { paste: ReturnType<typeof usePastedValues> }) {
  return (
    <details className="group" open={paste.text ? true : undefined}>
      <summary className="link cursor-pointer text-[12.5px] font-medium">Paste several at once</summary>
      <div className="mt-2">
        <PasteValues paste={paste} placeholder="Paste a line from the chat. Every number, email and link in it is picked up." />
      </div>
    </details>
  );
}
