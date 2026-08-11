"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <main className="flex min-h-screen bg-[var(--color-background)]">
      {/* Left branding panel */}
      <div className="hidden w-[45%] flex-col justify-between bg-[var(--color-primary)] p-10 text-[var(--color-on-primary)] lg:flex">
        <div>
          <div className="flex items-center gap-3 text-2xl font-bold tracking-tight">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-9"
              aria-hidden
            >
              <path
                d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
                fill="currentColor"
              />
              <path
                d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.96 7.96 0 01-4.243-1.204l-.305-.18-2.872.854.854-2.872-.18-.305A7.96 7.96 0 014 12c0-4.411 3.589-8 8-8s8 3.589 8 8-3.589 8-8 8z"
                fill="currentColor"
              />
            </svg>
            Support Message Automation
          </div>
        </div>

        <div className="space-y-6">
          <h2 className="text-3xl font-bold leading-snug tracking-tight">
            Automate WhatsApp support with precision and safety.
          </h2>
          <p className="max-w-md text-base leading-relaxed opacity-80">
            Rule-based automation, intelligent message filtering, and real-time
            team notifications — all from a single dashboard.
          </p>
          <div className="flex gap-8 pt-2 text-sm opacity-70">
            <div className="flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-current" />
              Auto-Reply Engine
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-current" />
              Anti-Spam Safety
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block size-1.5 rounded-full bg-current" />
              Team Notifications
            </div>
          </div>
        </div>

        <p className="text-xs opacity-50">
          &copy; {new Date().getFullYear()} Support Automation. All rights reserved.
        </p>
      </div>

      {/* Right form panel */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          {/* Mobile-only logo */}
          <div className="flex items-center gap-3 text-xl font-bold tracking-tight lg:hidden">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-7 text-[var(--color-primary)]"
              aria-hidden
            >
              <path
                d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
                fill="currentColor"
              />
              <path
                d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.96 7.96 0 01-4.243-1.204l-.305-.18-2.872.854.854-2.872-.18-.305A7.96 7.96 0 014 12c0-4.411 3.589-8 8-8s8 3.589 8 8-3.589 8-8 8z"
                fill="currentColor"
              />
            </svg>
            <span className="text-[var(--color-foreground)]">Support Automation</span>
          </div>

          {/* Form card */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
            <form action={formAction} className="space-y-5">
              <div className="space-y-1">
                <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-foreground)]">
                  Welcome back
                </h1>
                <p className="text-sm text-[color:var(--color-muted-foreground)]">
                  Sign in to manage your automation dashboard.
                </p>
              </div>

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

              {state.error ? (
                <div className="flex items-center gap-2 rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[color:var(--color-danger-fg)]">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="size-4 shrink-0">
                    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                  {state.error}
                </div>
              ) : null}

              <Button type="submit" loading={pending} className="h-10 w-full text-sm font-semibold">
                Sign in
              </Button>
            </form>
          </div>

          <p className="text-center text-xs text-[color:var(--color-muted-foreground)]">
            Contact your administrator if you need access.
          </p>
        </div>
      </div>
    </main>
  );
}
