"use client";

import { useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { matchCatalogEntry, normalizeTag } from "@support-automation/shared";
import { quickCreateCatalogEntry } from "@/server/actions/clientConfiguration";

/**
 * Pickers for Add / Edit Client (Smart Import V5 §10) that reuse the project's lists from the Configuration
 * Center instead of retyping. Both submit an ordinary comma-separated hidden field, so the server reads exactly
 * what it always read.
 */

/**
 * Tags: chips with a searchable list of the project's tags (name or alias). A tag that is not on the list can
 * still be added to this client; "Create" also puts it on the list, and is offered only to someone who may
 * manage the lists.
 */
export function TagPicker({ name, initial, options, canCreate }: { name: string; initial: string; options: ReadonlyArray<{ name: string; aliases: string[] }>; canCreate: boolean }) {
  const [tags, setTags] = useState<string[]>(() => initial.split(",").map((t) => normalizeTag(t)).filter((t): t is string => Boolean(t)));
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typed = normalizeTag(query);
  const q = query.trim().toLowerCase();
  const matches = q ? options.filter((o) => !tags.includes(o.name) && (o.name.includes(q) || o.aliases.some((a) => a.toLowerCase().includes(q)))).slice(0, 8).map((o) => o.name) : [];
  const onList = typed ? matchCatalogEntry(typed, options.map((o, i) => ({ id: String(i), ...o }))) : null;

  const add = (tag: string | null) => {
    if (!tag || tags.includes(tag)) return setQuery("");
    setTags([...tags, tag]);
    setQuery("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(onList ? onList.name : typed);
    } else if (e.key === "Backspace" && !query && tags.length) setTags(tags.slice(0, -1));
  };

  return (
    <div>
      <input type="hidden" name={name} value={tags.join(", ")} />
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-neutral-bg)] px-2 py-0.5 text-[12.5px]">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setNote(null);
          }}
          onKeyDown={onKey}
          aria-label="Add a tag"
          placeholder={tags.length ? "" : "Search or type a tag"}
          className="h-7 min-w-28 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>
      {query.trim() ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
          {matches.map((m) => (
            <button key={m} type="button" onClick={() => add(m)} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 hover:border-[var(--color-accent)]">
              {m}
            </button>
          ))}
          {typed && !onList && !tags.includes(typed) ? (
            <>
              <button type="button" onClick={() => add(typed)} className="rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5">
                Use “{typed}” for this client
              </button>
              {canCreate ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const r = await quickCreateCatalogEntry("TAG", typed);
                    setBusy(false);
                    setNote(r.message);
                    if (r.ok) add(r.name ?? typed);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-[color:var(--color-accent)]"
                >
                  <Plus className="size-3" aria-hidden /> Create tag “{typed}”
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="mt-1 text-[11.5px] text-[color:var(--color-muted-foreground)]">{note}</p> : null}
    </div>
  );
}

/** Languages besides the primary one: chips plus "Add another language" from the language catalogue. */
export function OtherLanguages({ name, initial, languages, primary }: { name: string; initial: string; languages: readonly string[]; primary: string }) {
  const [list, setList] = useState<string[]>(() => initial.split(",").map((l) => l.trim()).filter(Boolean));
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const shown = list.filter((l) => l.toLowerCase() !== primary.trim().toLowerCase());
  const add = () => {
    const value = text.trim();
    if (value && !shown.some((l) => l.toLowerCase() === value.toLowerCase()) && value.toLowerCase() !== primary.trim().toLowerCase() && shown.length < 5) setList([...shown, value]);
    setText("");
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name={name} value={shown.join(", ")} />
      {shown.map((l) => (
        <span key={l} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-neutral-bg)] px-2 py-0.5 text-[12.5px]">
          {l}
          <button type="button" aria-label={`Remove ${l}`} onClick={() => setList(shown.filter((x) => x !== l))}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            list="client-languages"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              } else if (e.key === "Escape") setAdding(false);
            }}
            onBlur={add}
            aria-label="Another language"
            className="h-7 w-40 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12.5px]"
          />
        </span>
      ) : shown.length < 5 ? (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">
          <Plus className="size-3" aria-hidden /> Add another language
        </button>
      ) : null}
      <datalist id="client-languages">
        {languages.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </div>
  );
}

/** "Auto selected" / "Manually selected" / "From the file" beside a value that can be either. */
export function SourceNote({ source }: { source: "AUTO" | "MANUAL" | "SAVED" | null }) {
  if (!source || source === "SAVED") return null;
  return (
    <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${source === "AUTO" ? "bg-[var(--color-info-bg)] text-[color:var(--color-info-fg)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
      {source === "AUTO" ? "Auto selected" : "Manually selected"}
    </span>
  );
}
