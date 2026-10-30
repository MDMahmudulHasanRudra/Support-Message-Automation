"use client";

import { useEffect, useState, useTransition } from "react";
import { Copy, Sparkles } from "lucide-react";
import { SOCIAL_AI_KIND_LABELS, SOCIAL_AI_KINDS, SOCIAL_AI_TONES, SOCIAL_PLATFORMS, type SocialAiKind } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { readSocialAiAction, requestSocialAiAction } from "@/server/actions/social";
import type { SocialAiRequestView } from "@/server/social/ai";

const NEEDS_TEXT: readonly SocialAiKind[] = ["REWRITE", "ADAPT", "EVALUATE"];

/**
 * Ask the AI for ideas, captions, hashtags, rewrites, platform adaptations, a campaign plan or a review.
 * The answer is a suggestion: "Start a post with this" opens the composer with it, marked AI-assisted;
 * it is published only after a person approves and schedules it.
 */
export function AiStudio({ canEdit, products, initial }: { canEdit: boolean; products: Array<{ id: string; name: string }> | null; initial: SocialAiRequestView | null }) {
  const [kind, setKind] = useState<SocialAiKind>("CAPTION");
  const [request, setRequest] = useState<SocialAiRequestView | null>(initial);
  const [requestId, setRequestId] = useState<string | null>(initial && (initial.status === "PENDING" || initial.status === "PROCESSING") ? initial.id : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    if (!requestId) return;
    let stop = false;
    const tick = async () => {
      const r = await readSocialAiAction(requestId);
      if (stop) return;
      if (r) setRequest(r);
      if (r && (r.status === "PENDING" || r.status === "PROCESSING")) timer = setTimeout(tick, 2000);
      else setRequestId(null);
    };
    let timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [requestId]);

  function submit(form: FormData) {
    setError(null);
    const input = {
      kind,
      brief: String(form.get("brief") ?? ""),
      text: String(form.get("text") ?? ""),
      tone: String(form.get("tone") ?? "friendly"),
      language: String(form.get("language") ?? "same"),
      platform: String(form.get("platform") ?? "") || null,
      count: Number(form.get("count") ?? 3),
      productIds: form.getAll("product").map(String),
    };
    start(async () => {
      const r = await requestSocialAiAction(input);
      if (r.error || !r.id) setError(r.error ?? "The request could not be made.");
      else {
        setRequest(null);
        setRequestId(r.id);
      }
    });
  }

  const busy = Boolean(requestId);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <form action={submit} className="space-y-4">
        <Field label="What should the AI do?" htmlFor="kind">
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as SocialAiKind)}>
            {SOCIAL_AI_KINDS.map((k) => (
              <option key={k} value={k}>
                {SOCIAL_AI_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What is it about?" htmlFor="brief" hint="The offer, the occasion, the audience — facts the AI may use.">
          <Textarea id="brief" name="brief" rows={3} maxLength={2000} />
        </Field>
        {NEEDS_TEXT.includes(kind) ? (
          <Field label="Text to work on" htmlFor="text" required>
            <Textarea id="text" name="text" rows={5} maxLength={8000} />
          </Field>
        ) : null}
        {products && products.length ? (
          <Field label="Products (their catalogue facts are the only ones the AI may state)" htmlFor="product">
            <select id="product" name="product" multiple size={Math.min(6, products.length)} className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-sm">
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tone" htmlFor="tone">
            <Select id="tone" name="tone" defaultValue="friendly">
              {SOCIAL_AI_TONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language" htmlFor="language">
            <Input id="language" name="language" list="ai-languages" defaultValue="same" />
            <datalist id="ai-languages">
              <option value="same" />
              <option value="Bengali (Bangla)" />
              <option value="Banglish (Bengali in Latin letters)" />
              <option value="English" />
            </datalist>
          </Field>
          <Field label="Platform" htmlFor="platform">
            <Select id="platform" name="platform" defaultValue="">
              <option value="">Any</option>
              {Object.values(SOCIAL_PLATFORMS).map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How many options" htmlFor="count">
            <Select id="count" name="count" defaultValue="3">
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? <Alert tone="danger" title={error} /> : null}
        {canEdit ? (
          <Button type="submit" variant="primary" loading={pending || busy}>
            <Sparkles className="size-4" aria-hidden /> {busy ? "Thinking…" : "Ask the AI"}
          </Button>
        ) : (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">Your role can read AI answers but not ask for new ones.</p>
        )}
      </form>

      <section aria-live="polite" className="min-w-0 space-y-3">
        {!request && !busy ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Answers appear here. They are suggestions: you choose, edit and send them for approval.</p> : null}
        {busy && (!request || request.status === "PENDING" || request.status === "PROCESSING") ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Waiting for the AI…</p> : null}
        {request?.status === "FAILED" || request?.status === "CANCELLED" ? <Alert tone="warning" title={request.reason ?? "No answer."} /> : null}
        {request?.status === "COMPLETE"
          ? request.options.map((option, i) => (
              <div key={i} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm shadow-[var(--shadow-xs)]">
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{option}</p>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <button
                    type="button"
                    className="link inline-flex items-center gap-1"
                    onClick={() => {
                      void navigator.clipboard?.writeText(option).then(() => setCopied(i));
                    }}
                  >
                    <Copy className="size-3" aria-hidden /> {copied === i ? "Copied" : "Copy"}
                  </button>
                  {canEdit && request.textKind ? (
                    <Link href={`/social/new?ai=${request.id}&option=${i}`} className="link">
                      Start a post with this
                    </Link>
                  ) : null}
                </div>
              </div>
            ))
          : null}
      </section>
    </div>
  );
}
