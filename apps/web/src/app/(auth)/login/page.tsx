"use client";

import { useActionState } from "react";
import { Alert, BrandMark, Button, Field, Input } from "@/components/ui";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

const CAPABILITIES = [
  { title: "Rule-based triage", detail: "Every inbound message matched against priority-ordered rules." },
  { title: "Escalation timers", detail: "SLA clocks that page the right person before a customer chases." },
  { title: "Anti-spam limits", detail: "Per-client cooldowns and global rate caps on every auto-reply." },
];

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <main className="flex min-h-dvh bg-[var(--color-background)]">
      {/* Left panel — the one place in the product that carries brand rather than
          data, so it is allowed the dark treatment the console itself avoids. */}
      <aside className="relative hidden w-[46%] max-w-[620px] flex-col justify-between overflow-hidden bg-[#0b0b0d] p-12 text-[#fafafa] lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(120% 80% at 15% 0%, rgba(255,255,255,0.10) 0%, transparent 55%), radial-gradient(90% 70% at 90% 100%, rgba(255,255,255,0.06) 0%, transparent 60%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.06'/%3E%3C/svg%3E\")",
          }}
        />

        <div className="relative flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-[var(--radius-md)] bg-[#fafafa] text-[#0b0b0d]">
            <svg viewBox="0 0 24 24" fill="none" className="size-[62%]" aria-hidden>
              <path d="M5.5 16.5V8.2A2.7 2.7 0 0 1 8.2 5.5h4.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <path d="M18.5 7.5v8.3a2.7 2.7 0 0 1-2.7 2.7h-4.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="17" cy="5.6" r="2.3" fill="currentColor" />
              <circle cx="7" cy="18.4" r="2.3" fill="currentColor" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Support Message Automation</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-[40px] font-semibold leading-[1.08] tracking-[-0.03em]">
            WhatsApp support that answers before anyone has to.
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-white/60">
            Deterministic rules decide what gets an instant reply, what waits for a human, and what
            escalates — with the whole decision trace recorded for every message.
          </p>

          <dl className="mt-10 space-y-4 border-t border-white/10 pt-8">
            {CAPABILITIES.map((item) => (
              <div key={item.title} className="flex gap-3">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-white/40" aria-hidden />
                <div>
                  <dt className="text-[13px] font-medium">{item.title}</dt>
                  <dd className="mt-0.5 text-[13px] leading-relaxed text-white/45">{item.detail}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-xs text-white/30">
          &copy; {new Date().getFullYear()} Support Automation
        </p>
      </aside>

      {/* Right form panel */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="size-8" />
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
              Support Automation
            </span>
          </div>

          <div className="mb-7">
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] text-[color:var(--color-foreground)]">
              Sign in
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Use your dashboard account to continue.
            </p>
          </div>

          <form action={formAction} className="space-y-4">
            <Field label="Username" htmlFor="username">
              <Input
                id="username"
                name="username"
                type="text"
                required
                autoComplete="username"
                placeholder="admin"
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="Enter your password"
              />
            </Field>

            {state.error ? <Alert tone="danger">{state.error}</Alert> : null}

            <Button type="submit" loading={pending} className="h-10 w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-8 border-t border-[var(--color-border)] pt-6 text-xs text-[color:var(--color-muted-foreground)]">
            Contact your administrator if you need access.
          </p>
        </div>
      </div>
    </main>
  );
}
