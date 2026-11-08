"use client";

import { useMemo, useState } from "react";
import { AtSign, Briefcase, Camera, Check, Copy, Globe, Mail, MessageCircle, MessagesSquare, Music2, Phone, Play, Send, type LucideIcon } from "lucide-react";
import {
  CONTACT_IDENTIFIER_KINDS,
  CONTACT_IDENTIFIER_LABEL,
  extractContactIdentifiers,
  type ContactIdentifierKindValue,
  type ContactIdentifierReading,
} from "@support-automation/shared";
import { Select, Textarea, useToast } from "@/components/ui";

export const KIND_ICON: Record<ContactIdentifierKindValue, LucideIcon> = {
  PHONE: Phone,
  EMAIL: Mail,
  FACEBOOK: MessagesSquare,
  INSTAGRAM: Camera,
  TELEGRAM: Send,
  TIKTOK: Music2,
  LINKEDIN: Briefcase,
  X: AtSign,
  YOUTUBE: Play,
  WEBSITE: Globe,
  OTHER: AtSign,
};

export function WhatsAppMark() {
  return <MessageCircle className="size-3.5 text-[color:var(--color-success-fg)]" aria-label="On WhatsApp" />;
}

export function contactInitial(name: string): string {
  const letter = [...name.trim()][0];
  return letter ? letter.toUpperCase() : "?";
}

export function ContactAvatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-bg)] font-semibold text-[color:var(--color-accent-fg)] ${large ? "size-14 text-[22px]" : "size-9 text-[14px]"}`}>
      {contactInitial(name)}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { showToast } = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          showToast({ tone: "success", title: "Copied" });
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

export type PickedValue = { kind: ContactIdentifierKindValue; value: string };

/** What has been pasted so far and how it reads. The parent keeps this, so its own Save knows the values. */
export function usePastedValues(defaultHandleKind?: ContactIdentifierKindValue) {
  const [text, setText] = useState("");
  const [kinds, setKinds] = useState<Record<string, ContactIdentifierKindValue>>({});
  const found = useMemo(() => extractContactIdentifiers(text), [text]);
  const values = found.map((f) => withKind(f, kinds[f.normalized] ?? (f.kind === "OTHER" ? defaultHandleKind : undefined)));
  return {
    text,
    setText,
    found,
    values,
    setKind: (normalized: string, kind: ContactIdentifierKindValue) => setKinds((k) => ({ ...k, [normalized]: kind })),
    clear: () => {
      setText("");
      setKinds({});
    },
  };
}
export type PastedValues = ReturnType<typeof usePastedValues>;

/**
 * The box people paste into: a line from a chat, a list of numbers, a profile link. What it finds appears below as it is
 * typed, each value with its kind, and only those are saved. A bare @handle says nothing about the app, so it gets a choice.
 */
export function PasteValues({ paste, rows = 2, placeholder }: { paste: PastedValues; rows?: number; placeholder?: string }) {
  return (
    <div className="space-y-2">
      <Textarea value={paste.text} onChange={(e) => paste.setText(e.target.value)} rows={rows} placeholder={placeholder ?? "Paste from the chat: numbers, emails, profile links"} />
      {paste.found.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {paste.found.map((f, i) => {
            const shown = paste.values[i]!;
            const Icon = KIND_ICON[shown.kind];
            return (
              <li key={`${f.kind}:${f.normalized}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--color-neutral-bg)] px-2.5 py-1 text-[12.5px] text-[color:var(--color-foreground)]">
                <Icon className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                <span className="truncate">{shown.value}</span>
                {f.kind === "OTHER" ? (
                  <select aria-label={`Which app is ${f.value} on?`} value={shown.kind} onChange={(e) => paste.setKind(f.normalized, e.target.value as ContactIdentifierKindValue)} className="bg-transparent text-[12px] text-[color:var(--color-muted-foreground)]">
                    {(["OTHER", "FACEBOOK", "INSTAGRAM", "TELEGRAM", "TIKTOK", "LINKEDIN", "X", "YOUTUBE"] as const).map((k) => (
                      <option key={k} value={k}>
                        {CONTACT_IDENTIFIER_LABEL[k]}
                      </option>
                    ))}
                  </select>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : paste.text.trim() ? (
        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">No number, email or link found in that yet.</p>
      ) : null}
    </div>
  );
}

function withKind(reading: ContactIdentifierReading, kind: ContactIdentifierKindValue | undefined): PickedValue {
  if (!kind || kind === reading.kind) return { kind: reading.kind, value: reading.value };
  return { kind, value: reading.value.replace(/^@/, "") };
}

export function ManualValueRow({ kind, onKind, value, onValue }: { kind: ContactIdentifierKindValue; onKind: (k: ContactIdentifierKindValue) => void; value: string; onValue: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Select aria-label="Kind" value={kind} onChange={(e) => onKind(e.target.value as ContactIdentifierKindValue)} className="w-36 shrink-0">
        {CONTACT_IDENTIFIER_KINDS.map((k) => (
          <option key={k} value={k}>
            {CONTACT_IDENTIFIER_LABEL[k]}
          </option>
        ))}
      </Select>
      <input
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder={kind === "PHONE" ? "01XXXXXXXXX" : kind === "EMAIL" ? "name@example.com" : "Username or link"}
        className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13.5px]"
      />
    </div>
  );
}
