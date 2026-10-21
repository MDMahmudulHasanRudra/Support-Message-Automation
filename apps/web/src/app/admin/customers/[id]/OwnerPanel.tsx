"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { Alert, Badge, Button, Field, Input, useToast } from "@/components/ui";
import { createOwnerLogin, inviteOwner, revokeInvitation, type BillingActionResult } from "@/server/actions/saasBilling";
import type { CustomerPerson, InvitationView } from "@/server/saasBilling";

/**
 * The customer's people and the owner's access (SAAS_PLATFORM_PLAN.md section 10.5). The owner is
 * the workspace's Lead: they manage their own members and roles from inside the workspace. Nobody
 * created here can hold a platform permission.
 */
export function OwnerPanel({ customerId, people, invitations, canManage }: { customerId: string; people: CustomerPerson[]; invitations: InvitationView[]; canManage: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [mode, setMode] = useState<null | "invite" | "login">(null);
  const [inviteState, inviteAction, inviting] = useActionState<BillingActionResult, FormData>(inviteOwner.bind(null, customerId), {});
  const [loginState, loginAction, creating] = useActionState<BillingActionResult, FormData>(async (_prev, fd) => {
    const r = await createOwnerLogin(customerId, {}, fd);
    if (r.success) setMode(null);
    return r;
  }, {});
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (inviteState.success) router.refresh();
  }, [inviteState, router]);
  useEffect(() => {
    if (loginState.success) {
      showToast({ tone: "success", title: "Owner created", description: loginState.success });
      router.refresh();
    }
  }, [loginState, showToast, router]);

  const pending = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > new Date());

  return (
    <div className="space-y-4">
      {people.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">Nobody from this customer has a login yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] text-sm">
          {people.map((p) => (
            <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <NextLink href={`/admin/users/${p.userId}`} className="font-medium hover:underline">
                  {p.name}
                </NextLink>{" "}
                <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">{p.username}</span>
              </span>
              <span className="flex items-center gap-2">
                {p.isLead ? <Badge color="blue">Owner (Lead)</Badge> : null}
                {!p.isActive ? <Badge color="gray">Inactive</Badge> : null}
                <span className="text-xs text-[color:var(--color-muted-foreground)]">{p.lastLoginAt ? `last sign-in ${new Date(p.lastLoginAt).toLocaleDateString()}` : "never signed in"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">Open invitations</p>
          {pending.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {i.name}
                {i.email ? ` · ${i.email}` : ""} <span className="text-xs text-[color:var(--color-muted-foreground)]">expires {new Date(i.expiresAt).toLocaleString()}{i.emailedAt ? " · emailed" : ""}</span>
              </span>
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    startTransition(async () => {
                      const r = await revokeInvitation(i.id);
                      showToast({ tone: r.error ? "danger" : "success", title: r.error ? "Not done" : "Revoked", description: r.error ?? r.success ?? "" });
                      router.refresh();
                    })
                  }
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {inviteState.link ? (
        <Alert tone="success" title="Invitation link — shown once">
          <p className="mb-2">{inviteState.success}</p>
          <code className="block break-all rounded bg-[var(--color-surface-sunken)] p-2 font-mono text-xs">{inviteState.link}</code>
          <p className="mt-2 text-xs">Single use, valid for 72 hours. Send it privately.</p>
        </Alert>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={mode === "invite" ? "primary" : "secondary"} onClick={() => setMode(mode === "invite" ? null : "invite")}>
            Invite owner
          </Button>
          <Button size="sm" variant={mode === "login" ? "primary" : "ghost"} onClick={() => setMode(mode === "login" ? null : "login")}>
            Create owner login
          </Button>
        </div>
      ) : null}

      {mode === "invite" ? (
        <form action={inviteAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Owner's name" htmlFor="io-name" required error={inviteState.fieldErrors?.name}>
              <Input id="io-name" name="name" maxLength={120} required />
            </Field>
            <Field label="Email (optional)" htmlFor="io-email" error={inviteState.fieldErrors?.email} hint="Emailed when platform email is set up; otherwise copy the link.">
              <Input id="io-email" name="email" type="email" maxLength={200} />
            </Field>
          </div>
          {inviteState.error ? <Alert tone="danger">{inviteState.error}</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={inviting}>
              Create invitation
            </Button>
          </div>
        </form>
      ) : null}

      {mode === "login" ? (
        <form action={loginAction} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="ol-name" required>
              <Input id="ol-name" name="name" maxLength={120} required />
            </Field>
            <Field label="Username" htmlFor="ol-username" required>
              <Input id="ol-username" name="username" maxLength={60} required autoComplete="off" />
            </Field>
            <Field label="Email" htmlFor="ol-email">
              <Input id="ol-email" name="email" type="email" maxLength={200} autoComplete="off" />
            </Field>
            <div />
            <Field label="Password" htmlFor="ol-password" required hint="At least 12 characters. Share it privately.">
              <Input id="ol-password" name="password" type="password" autoComplete="new-password" required />
            </Field>
            <Field label="Confirm password" htmlFor="ol-confirm" required>
              <Input id="ol-confirm" name="confirmPassword" type="password" autoComplete="new-password" required />
            </Field>
          </div>
          {loginState.error ? <Alert tone="danger">{loginState.error}</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={creating}>
              Create login
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
