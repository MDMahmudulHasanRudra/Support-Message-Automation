"use client";

import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Archive, CheckCircle2, Copy, Save, Undo2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { duplicateMessageTemplate, saveMessageTemplate, setMessageTemplateStatus, type TemplateFormState } from "@/server/actions/clientMessages";
import {
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_CATEGORY_LABELS,
  MESSAGE_TEMPLATE_CHANNELS,
  MESSAGE_TEMPLATE_CHANNEL_LABELS,
  MESSAGE_TEMPLATE_LIMITS,
  MESSAGE_VARIABLES,
  renderMessageTemplate,
  SAMPLE_MESSAGE_VALUES,
  validateMessageTemplate,
} from "@support-automation/shared";
import { RowMenu } from "../RowMenu";

/** Activate / move to draft / archive / duplicate, from the template card. */
export function TemplateRowActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) router.refresh();
    });
  return (
    <RowMenu
      horizontal
      label="Template actions"
      items={[
        { label: "Activate", icon: <CheckCircle2 className="size-4" aria-hidden />, onSelect: () => run(() => setMessageTemplateStatus(id, "ACTIVE")), hidden: status === "ACTIVE" },
        { label: "Move to draft", icon: <Undo2 className="size-4" aria-hidden />, onSelect: () => run(() => setMessageTemplateStatus(id, "DRAFT")), hidden: status !== "ACTIVE" },
        { label: "Duplicate", icon: <Copy className="size-4" aria-hidden />, onSelect: () => run(() => duplicateMessageTemplate(id)) },
        { label: "Archive", icon: <Archive className="size-4" aria-hidden />, onSelect: () => run(() => setMessageTemplateStatus(id, "ARCHIVED")), hidden: status === "ARCHIVED", danger: true },
      ]}
    />
  );
}

export interface TemplateInitial {
  id: string | null;
  version: number;
  name: string;
  category: string;
  channel: string;
  language: string;
  subject: string;
  body: string;
  status: string;
}

/**
 * The template editor: fields, the variables (click to insert at the cursor), and a live preview filled with
 * SAMPLE values. Validation runs here for convenience and again on the server, which is what decides.
 */
export function TemplateEditor({ initial, canEdit }: { initial: TemplateInitial; canEdit: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [dirty, setDirty] = useState(false);
  const [state, action, pending] = useActionState<TemplateFormState, FormData>(async (prev, form) => {
    const result = await saveMessageTemplate(initial.id, prev, form);
    if (result.success) {
      showToast({ tone: "success", title: result.success });
      setDirty(false);
      if (!initial.id && result.templateId) router.replace(`/clients/templates/${result.templateId}`);
      else router.refresh();
    }
    return result;
  }, {});
  const [fields, setFields] = useState({ name: initial.name, category: initial.category || "CUSTOM", channel: initial.channel || "ANY", language: initial.language, subject: initial.subject, body: initial.body });
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<"subject" | "body">("body");

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = (k: keyof typeof fields, value: string) => {
    setFields((f) => ({ ...f, [k]: value }));
    setDirty(true);
  };
  const check = useMemo(() => validateMessageTemplate(fields), [fields]);
  const preview = useMemo(() => renderMessageTemplate({ subject: fields.subject || null, body: fields.body }, SAMPLE_MESSAGE_VALUES), [fields.subject, fields.body]);

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const el = focus === "subject" ? subjectRef.current : bodyRef.current;
    const field = focus;
    const current = fields[field];
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    set(field, current.slice(0, start) + token + current.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <form action={action} className="space-y-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-xs)]">
        <input type="hidden" name="version" value={initial.version} />
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <fieldset disabled={!canEdit || pending} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input name="name" value={fields.name} onChange={(e) => set("name", e.target.value)} maxLength={MESSAGE_TEMPLATE_LIMITS.name} required />
            </Field>
            <Field label="Language" hint="Optional, for your own sorting (for example Bangla, English).">
              <Input name="language" value={fields.language} onChange={(e) => set("language", e.target.value)} maxLength={MESSAGE_TEMPLATE_LIMITS.language} />
            </Field>
            <Field label="Category">
              <Select name="category" value={fields.category} onChange={(e) => set("category", e.target.value)}>
                {MESSAGE_TEMPLATE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {MESSAGE_TEMPLATE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Channel" hint="Email is sent by Get Assist; the others are prepared for a person to send.">
              <Select name="channel" value={fields.channel} onChange={(e) => set("channel", e.target.value)}>
                {MESSAGE_TEMPLATE_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {MESSAGE_TEMPLATE_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Subject" hint={fields.channel === "EMAIL" ? "Required for email." : "Used when this wording is sent by email."}>
            <Input ref={subjectRef} name="subject" value={fields.subject} onFocus={() => setFocus("subject")} onChange={(e) => set("subject", e.target.value)} maxLength={MESSAGE_TEMPLATE_LIMITS.subject} />
          </Field>
          <Field label="Message" hint="Plain text — never HTML. Click a variable on the right to insert it where the cursor is.">
            <Textarea ref={bodyRef} name="body" value={fields.body} onFocus={() => setFocus("body")} onChange={(e) => set("body", e.target.value)} rows={12} maxLength={MESSAGE_TEMPLATE_LIMITS.body} />
          </Field>
          <div className="flex items-center justify-between gap-2 text-xs text-[color:var(--color-muted-foreground)]">
            <span>
              {fields.body.length}/{MESSAGE_TEMPLATE_LIMITS.body} characters
            </span>
            {!check.ok ? <span className="text-[color:var(--color-danger-fg)]">{check.errors[0]}</span> : null}
          </div>
        </fieldset>
        {canEdit ? (
          <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
            <Button type="submit" name="status" value="DRAFT" variant="secondary" loading={pending} disabled={!check.ok}>
              <Save className="size-4" aria-hidden /> Save as draft
            </Button>
            <Button type="submit" name="status" value="ACTIVE" loading={pending} disabled={!check.ok}>
              <CheckCircle2 className="size-4" aria-hidden /> Save and activate
            </Button>
          </div>
        ) : null}
      </form>
      <aside className="space-y-4">
        <div className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold">Variables</h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {MESSAGE_VARIABLES.map((v) => (
              <li key={v.key}>
                <button type="button" disabled={!canEdit} onClick={() => insert(v.key)} title={v.label} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[11.5px] hover:bg-[var(--color-neutral-bg)] disabled:opacity-60">
                  {`{{${v.key}}}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold">Preview with sample details</h2>
          {preview.subject ? <p className="mt-2 text-sm font-medium">{preview.subject}</p> : null}
          <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm">{preview.body || "—"}</p>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">Real messages use the client&apos;s own details. Money appears only for people allowed to see billing.</p>
        </div>
      </aside>
    </div>
  );
}
