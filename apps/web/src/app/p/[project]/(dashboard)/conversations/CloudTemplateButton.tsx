"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { FileText } from "lucide-react";
import { renderCloudTemplate } from "@support-automation/shared";
import { Alert, Button, Dialog, Field, Input, Select, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { listTemplatesAction, sendTemplateAction } from "@/server/actions/whatsappCloud";

type Template = Awaited<ReturnType<typeof listTemplatesAction>>[number];

/** WhatsApp (Official API): an approved template, the only message allowed after 24 hours. One person, one press. */
export function CloudTemplateButton({ conversationId }: { conversationId: string }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const nonce = useRef("");

  useEffect(() => {
    if (!open) return;
    nonce.current = crypto.randomUUID();
    let live = true;
    void listTemplatesAction(conversationId).then((t) => {
      if (live) setTemplates(t);
    });
    return () => {
      live = false;
    };
  }, [open, conversationId]);

  const template = templates?.find((t) => t.id === templateId) ?? null;
  const choose = (id: string) => {
    setTemplateId(id);
    const t = templates?.find((x) => x.id === id);
    setParams(Array.from({ length: t?.paramCount ?? 0 }, () => ""));
  };
  const send = () =>
    start(async () => {
      const r = await sendTemplateAction({ conversationId, templateId, params, nonce: nonce.current });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setOpen(false);
      setTemplateId("");
      setParams([]);
      setError(null);
      showToast({ tone: "success", title: "Template queued" });
      router.refresh();
    });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[12px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
        <FileText className="size-3.5" aria-hidden />
        Send a template
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Send a template" description="Approved by Meta. Meta charges for each one, and it is the only message allowed after 24 hours.">
        <div className="space-y-3.5">
          {templates && templates.length === 0 ? <Alert tone="warning">No approved templates yet. Press Sync templates on this number&apos;s settings page.</Alert> : null}
          <Field label="Template">
            <Select value={templateId} onChange={(e) => choose(e.target.value)} disabled={!templates}>
              <option value="">{templates ? "Choose one" : "Loading…"}</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language}, {t.category.toLowerCase()})
                </option>
              ))}
            </Select>
          </Field>
          {params.map((value, i) => (
            <Field key={i} label={`Blank ${i + 1}`}>
              <Input value={value} maxLength={1024} onChange={(e) => setParams((p) => p.map((v, n) => (n === i ? e.target.value : v)))} />
            </Field>
          ))}
          {template ? <p className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[13px]">{renderCloudTemplate(template.bodyText, params)}</p> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={send} disabled={pending || !template || params.some((p) => !p.trim())}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
