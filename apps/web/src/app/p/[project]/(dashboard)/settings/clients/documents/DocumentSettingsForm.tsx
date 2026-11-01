"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea, useToast } from "@/components/ui";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { previewDocumentSettings, saveDocumentSettings, type DocumentSettingsFormState } from "@/server/actions/clientDocuments";
import { DOCUMENT_LIMITS, type DocumentSettingsValue } from "@support-automation/shared";

/**
 * The Invoice & Receipt setup form with a live preview beside it. The preview is rendered on the server (the very
 * renderer that prints documents) and shown in a sandboxed frame, so what you see is what a client gets.
 */
export function DocumentSettingsForm({ canEdit, version, initial, hasLogo, hasSignature }: { canEdit: boolean; version: number | null; initial: DocumentSettingsValue; hasLogo: boolean; hasSignature: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, action, pending] = useActionState<DocumentSettingsFormState, FormData>(saveDocumentSettings, {});
  const form = useRef<HTMLFormElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: state.success });
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per result
  }, [state]);

  // Re-render the preview a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!form.current) return;
      const data = new FormData(form.current);
      const fields: Record<string, string> = {};
      for (const [k, v] of data.entries()) if (typeof v === "string") fields[k] = v;
      void previewDocumentSettings(fields, {
        logoSha256: data.get("removeLogo") === "1" ? null : initial.logoSha256,
        signatureSha256: data.get("removeSignature") === "1" ? null : initial.signatureSha256,
      }).then((r) => {
        if ("html" in r) setHtml(r.html);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [tick, initial]);

  const v = (key: keyof DocumentSettingsValue) => state.values?.[key] ?? String(initial[key] ?? "");
  const disabled = !canEdit || pending;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card className="p-6">
        <form ref={form} action={action} onInput={() => setTick((n) => n + 1)} onChange={() => setTick((n) => n + 1)} className="space-y-6">
          <input type="hidden" name="version" value={version ?? 0} />
          {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

          <fieldset className="space-y-3" disabled={disabled}>
            <legend className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">Business</legend>
            <Field label="Business name" hint="Printed at the top. Empty = the project's name.">
              <Input name="businessName" defaultValue={v("businessName")} maxLength={DOCUMENT_LIMITS.businessName} />
            </Field>
            <Field label="Address">
              <Textarea name="address" defaultValue={v("address")} rows={2} maxLength={DOCUMENT_LIMITS.address} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Phone">
                <Input name="phone" defaultValue={v("phone")} maxLength={DOCUMENT_LIMITS.line} />
              </Field>
              <Field label="Support email">
                <Input name="email" type="email" defaultValue={v("email")} maxLength={DOCUMENT_LIMITS.line} />
              </Field>
              <Field label="Website">
                <Input name="website" defaultValue={v("website")} maxLength={DOCUMENT_LIMITS.line} placeholder="www.example.com" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tax / VAT label" hint="For example VAT Reg. No., BIN or TRN. Optional.">
                <Input name="taxLabel" defaultValue={v("taxLabel")} maxLength={DOCUMENT_LIMITS.taxLabel} />
              </Field>
              <Field label="Tax / VAT number">
                <Input name="taxNumber" defaultValue={v("taxNumber")} maxLength={DOCUMENT_LIMITS.taxNumber} />
              </Field>
            </div>
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Invoices here carry no tax calculation, so no tax amount is ever printed. Whether a document meets a country&apos;s tax-invoice rules is for the business to confirm.
            </p>
          </fieldset>

          <fieldset className="space-y-3" disabled={disabled}>
            <legend className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">Look</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Logo" hint={hasLogo ? "A logo is set. Choose a file to replace it." : "PNG or JPEG, at most 256 KB."}>
                <Input name="logo" type="file" accept="image/png,image/jpeg" />
              </Field>
              <Field label="Signature image" hint={hasSignature ? "A signature is set. Choose a file to replace it." : "Optional. PNG or JPEG, at most 256 KB."}>
                <Input name="signature" type="file" accept="image/png,image/jpeg" />
              </Field>
            </div>
            <div className="flex flex-wrap gap-4">
              {hasLogo ? (<label className="inline-flex items-center gap-2 text-sm"><Checkbox name="removeLogo" value="1" /> Remove the logo</label>) : null}
              {hasSignature ? (<label className="inline-flex items-center gap-2 text-sm"><Checkbox name="removeSignature" value="1" /> Remove the signature image</label>) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Brand colour">
                <Input name="accentColor" type="color" defaultValue={v("accentColor")} className="h-10 p-1" />
              </Field>
              <Field label="Paper size">
                <Select name="paperSize" defaultValue={v("paperSize")}>
                  <option value="A4">A4</option>
                  <option value="LETTER">Letter</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Invoice title">
                <Input name="invoiceTitle" defaultValue={v("invoiceTitle")} maxLength={DOCUMENT_LIMITS.title} />
              </Field>
              <Field label="Receipt title">
                <Input name="receiptTitle" defaultValue={v("receiptTitle")} maxLength={DOCUMENT_LIMITS.title} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-3" disabled={disabled}>
            <legend className="mb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">Wording</legend>
            <Field label="Payment instructions" hint="Printed on invoices: bank, mobile banking number, reference to use.">
              <Textarea name="paymentInstructions" defaultValue={v("paymentInstructions")} rows={3} maxLength={DOCUMENT_LIMITS.paymentInstructions} />
            </Field>
            <Field label="Terms and conditions">
              <Textarea name="terms" defaultValue={v("terms")} rows={3} maxLength={DOCUMENT_LIMITS.terms} />
            </Field>
            <Field label="Footer">
              <Input name="footer" defaultValue={v("footer")} maxLength={DOCUMENT_LIMITS.footer} placeholder="Thank you for your business." />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Signatory name" hint="Optional. Adds a signature line.">
                <Input name="signatureName" defaultValue={v("signatureName")} maxLength={DOCUMENT_LIMITS.signatureName} />
              </Field>
              <Field label="Signatory title">
                <Input name="signatureTitle" defaultValue={v("signatureTitle")} maxLength={DOCUMENT_LIMITS.signatureTitle} />
              </Field>
            </div>
          </fieldset>

          {canEdit ? (
            <div className="sticky bottom-0 -mx-6 -mb-6 flex justify-end border-t border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-3">
              <Button type="submit" loading={pending}>
                <Save className="size-4" aria-hidden /> Save as a new version
              </Button>
            </div>
          ) : null}
        </form>
      </Card>
      <div className="xl:sticky xl:top-4 xl:self-start">
        <p className="mb-2 text-sm font-medium">Preview</p>
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[#eef0f3]">
          {html ? <iframe title="Invoice preview" sandbox="" srcDoc={html} className="block h-[820px] w-full" /> : <div className="h-[820px] animate-pulse" />}
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">A new logo or signature shows here after saving. The preview uses your newest real invoice when you can see billing, otherwise a sample.</p>
      </div>
    </div>
  );
}
