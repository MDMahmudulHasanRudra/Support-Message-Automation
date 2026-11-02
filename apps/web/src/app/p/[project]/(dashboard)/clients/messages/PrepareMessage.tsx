"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Copy, ExternalLink, Mail, MessageCircle, Send } from "lucide-react";
import Link from "@/components/ProjectLink";
import { Alert, Button, Dialog, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { listTemplateOptions, previewClientMessage, recordPreparedMessage, sendClientEmail, type MessagePreview, type TemplateOption } from "@/server/actions/clientMessages";
import { whatsappClickToChatUrl, type MessageTemplateCategory } from "@support-automation/shared";
import type { MessageContext } from "@/server/clientMessages";

type Channel = "EMAIL" | "WHATSAPP" | "COPY";

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

/**
 * "Message client" (CLIENT_CRM_V7.md §6): choose a template, see it filled with this client's own details, adjust
 * the words, then EITHER queue it as an email (the one channel Get Assist sends through), OR open WhatsApp's own
 * click-to-chat / the linked conversation, OR copy it. Choosing a template sends nothing; WhatsApp and copy are
 * recorded as prepared, never as sent.
 */
export function PrepareMessageButton({ clientId, context, category, label = "Message client", size = "sm", variant = "secondary" }: { clientId: string; context: MessageContext; category?: MessageTemplateCategory; label?: string; size?: "sm" | "md"; variant?: "primary" | "secondary" | "ghost" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Mail className="size-4" aria-hidden /> {label}
      </Button>
      {open ? <PrepareMessageDialog clientId={clientId} context={context} category={category} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function PrepareMessageDialog({ clientId, context, category, onClose }: { clientId: string; context: MessageContext; category?: MessageTemplateCategory; onClose: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templateId, setTemplateId] = useState<string>("");
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<Channel>("EMAIL");
  const [busy, start] = useTransition();
  const [submissionKey, setSubmissionKey] = useState(newKey);
  const contextKey = JSON.stringify(context);

  const load = useCallback(
    (id: string) => {
      setError(null);
      start(async () => {
        const r = await previewClientMessage(clientId, id || null, JSON.parse(contextKey));
        if (!r.ok) {
          setError(r.message);
          return;
        }
        setPreview(r);
        setSubject(r.subject ?? "");
        setBody(r.body);
        setSubmissionKey(newKey());
        setChannel(r.email.eligibility.ok && r.email.ready ? "EMAIL" : r.whatsapp.linkedChatHref || r.whatsapp.clickToChatNumber ? "WHATSAPP" : "COPY");
      });
    },
    [clientId, contextKey],
  );

  // The templates arrive once; the first preview is loaded from that answer (never set state in an effect body).
  useEffect(() => {
    let live = true;
    void listTemplateOptions().then((list) => {
      if (!live) return;
      setTemplates(list);
      const preferred = list.find((t) => t.category === category)?.id ?? "";
      setTemplateId(preferred);
      load(preferred);
    });
    return () => {
      live = false;
    };
  }, [category, load]);

  const waUrl = useMemo(() => (preview?.whatsapp.clickToChatNumber ? whatsappClickToChatUrl(preview.whatsapp.clickToChatNumber, body) : null), [preview, body]);
  const emailBlock = !preview
    ? null
    : !preview.email.canSend
      ? "Sending email to clients needs the Send and Prepare Messages permission."
      : !preview.email.ready
        ? preview.email.reason
        : !preview.email.eligibility.ok
          ? preview.email.eligibility.message
          : null;

  const recordPrepared = (ch: "WHATSAPP" | "COPY") =>
    recordPreparedMessage({ clientId, templateId: templateId || null, context, channel: ch, subject: "", body }).then((r) => {
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) router.refresh();
    });

  return (
    <Dialog open onClose={onClose} size="lg" title="Message client" description="Choose wording, check it, then send it by email or prepare it for WhatsApp. Nothing is sent until you press a send button.">
      <div className="space-y-4">
        <Field label="Template" hint={templates && templates.length === 0 ? "No active template yet — write the message yourself, or create templates under Clients → Message Templates." : undefined}>
          <Select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              load(e.target.value);
            }}
            disabled={templates === null}
          >
            <option value="">No template — write it myself</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.categoryLabel} · {t.name}
                {t.language ? ` (${t.language})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {preview && preview.missing.length ? (
          <Alert tone="warning">
            No value for {preview.missing.map((m) => `{{${m}}}`).join(", ")} — {preview.missing.length === 1 ? "it was" : "they were"} left out. Lines made only of missing details were dropped. Check the text before sending.
          </Alert>
        ) : null}

        <div role="tablist" aria-label="Send by" className="flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-1">
          {(
            [
              ["EMAIL", "Email", Mail],
              ["WHATSAPP", "WhatsApp", MessageCircle],
              ["COPY", "Copy text", Copy],
            ] as const
          ).map(([key, text, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={channel === key}
              onClick={() => setChannel(key)}
              className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm ${channel === key ? "bg-[var(--color-surface)] font-medium shadow-[var(--shadow-xs)]" : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"}`}
            >
              <Icon className="size-4" aria-hidden /> {text}
            </button>
          ))}
        </div>

        {channel === "EMAIL" ? (
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!preview} />
          </Field>
        ) : null}
        <Field label="Message" hint="Plain text. Edit freely — what you see is what is sent or copied.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} maxLength={8000} disabled={!preview} />
        </Field>

        {channel === "EMAIL" && preview ? (
          <div className="space-y-2">
            {emailBlock ? <Alert tone="info">{emailBlock}</Alert> : <p className="text-sm">To: <span className="font-medium">{preview.email.eligibility.ok ? preview.email.eligibility.address : ""}</span></p>}
            <div className="flex justify-end">
              <Button
                disabled={Boolean(emailBlock) || !subject.trim() || !body.trim()}
                loading={busy}
                onClick={() =>
                  start(async () => {
                    const r = await sendClientEmail({ clientId, templateId: templateId || null, context, subject, body, submissionKey });
                    showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                    if (r.ok) {
                      router.refresh();
                      onClose();
                    }
                  })
                }
              >
                <Send className="size-4" aria-hidden /> Send email
              </Button>
            </div>
          </div>
        ) : null}

        {channel === "WHATSAPP" && preview ? (
          <div className="space-y-3 text-sm">
            {preview.whatsapp.linkedChatHref && preview.whatsapp.canOpenChat ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
                <span>
                  Linked conversation on <span className="font-medium">{preview.whatsapp.linkedAccountLabel}</span> — paste the text into its composer.
                </span>
                <Link
                  href={preview.whatsapp.linkedChatHref}
                  onClick={() => {
                    void navigator.clipboard?.writeText(body).catch(() => undefined);
                    void recordPrepared("WHATSAPP");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3 py-1.5 font-medium text-[var(--color-on-primary)]"
                >
                  <MessageCircle className="size-4" aria-hidden /> Copy and open chat
                </Link>
              </div>
            ) : null}
            {waUrl ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
                <span className="max-w-[46ch]">Opens WhatsApp on this device with the text typed in. Nothing is sent until you press send there; Get Assist records it as prepared, not sent.</span>
                <a
                  href={waUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => void recordPrepared("WHATSAPP")}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 font-medium hover:bg-[var(--color-neutral-bg)]"
                >
                  <ExternalLink className="size-4" aria-hidden /> Open in WhatsApp
                </a>
              </div>
            ) : null}
            {!preview.whatsapp.linkedChatHref && !waUrl ? <Alert tone="info">{preview.whatsapp.reason ?? "No WhatsApp route for this client."}</Alert> : null}
            {!preview.canPrepare ? <p className="text-xs text-[color:var(--color-muted-foreground)]">Recording a prepared message needs the Send and Prepare Messages permission; the link still opens.</p> : null}
          </div>
        ) : null}

        {channel === "COPY" && preview ? (
          <div className="flex justify-end">
            <Button
              variant="secondary"
              disabled={!body.trim()}
              onClick={() => {
                void navigator.clipboard?.writeText(body).then(
                  () => showToast({ tone: "success", title: "Copied" }),
                  () => showToast({ tone: "danger", title: "This browser did not allow copying. Select the text and copy it by hand." }),
                );
                if (preview.canPrepare) void recordPrepared("COPY");
              }}
            >
              <Copy className="size-4" aria-hidden /> Copy text
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
