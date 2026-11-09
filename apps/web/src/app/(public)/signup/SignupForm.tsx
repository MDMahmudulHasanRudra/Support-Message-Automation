"use client";

import { useActionState, useState } from "react";
import { MailCheck } from "lucide-react";
import { suggestSignupSlug } from "@support-automation/shared";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { submitSignup, type SignupFormState } from "@/server/platform/actions/publicSignup";

export function SignupForm({ plans, initialPlan, suffix, stamp }: { plans: Array<{ id: string; label: string }>; initialPlan: string; suffix: string | null; stamp: string }) {
  const [state, action, pending] = useActionState<SignupFormState, FormData>(submitSignup, {});
  const [business, setBusiness] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const shownSlug = slugTouched ? slug : suggestSignupSlug(business);
  const e = state.fieldErrors ?? {};

  if (state.sent) {
    return (
      <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
        <MailCheck className="mx-auto size-9 text-[color:var(--color-success-fg)]" aria-hidden />
        <h2 className="mt-3 text-[17px] font-semibold">Check your email</h2>
        <p className="mt-1 text-[14px] text-[color:var(--color-muted-foreground)]">We sent you a link to confirm your address. It works for 48 hours. If you do not see it, look in your spam folder.</p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 space-y-3.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <input type="hidden" name="stamp" value={stamp} />
      {/* Out of sight for people; automated form-fillers complete it. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <Field label="Plan" error={e.planId}>
        <Select name="planId" defaultValue={initialPlan}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Business name" error={e.businessName}>
        <Input name="businessName" required maxLength={120} autoComplete="organization" value={business} onChange={(ev) => setBusiness(ev.target.value)} />
      </Field>
      <Field label="Your name" error={e.ownerName}>
        <Input name="ownerName" required maxLength={120} autoComplete="name" />
      </Field>
      <Field label="Email" error={e.email}>
        <Input name="email" type="email" required maxLength={200} autoComplete="email" />
      </Field>
      <Field label="Phone (optional)" error={e.phone}>
        <Input name="phone" type="tel" maxLength={40} autoComplete="tel" />
      </Field>
      <Field label="Your workspace address" error={e.slug} hint={suffix ? `${shownSlug || "your-business"}.${suffix}` : "Letters, numbers and dashes."}>
        <Input
          name="slug"
          required
          maxLength={40}
          value={shownSlug}
          onChange={(ev) => {
            setSlugTouched(true);
            setSlug(ev.target.value.toLowerCase());
          }}
        />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Continue"}
      </Button>
    </form>
  );
}
