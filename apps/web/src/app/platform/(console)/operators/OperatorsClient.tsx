"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Alert, Badge, Button, Field, Input, useToast } from "@/components/ui";
import { createOperator, resetOperatorPassword, setOperatorActive, type OperatorActionResult } from "@/server/platform/actions/operators";

interface OperatorRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  canSupport: boolean;
  lastLoginAt: string | null;
  createdByUsername: string | null;
}

export function OperatorsClient({ me, operators }: { me: string; operators: OperatorRow[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-[var(--color-border)] text-sm">
        {operators.map((o) => (
          <OperatorItem key={o.id} operator={o} isMe={o.id === me} />
        ))}
      </ul>
      {adding ? <AddOperator onDone={() => setAdding(false)} /> : <Button variant="secondary" onClick={() => setAdding(true)}>Add operator</Button>}
    </div>
  );
}

function OperatorItem({ operator, isMe }: { operator: OperatorRow; isMe: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [mode, setMode] = useState<null | "toggle" | "password">(null);
  const [state, action, pending] = useActionState<OperatorActionResult, FormData>(async (_prev, fd) => {
    const r = mode === "password" ? await resetOperatorPassword(operator.id, fd) : await setOperatorActive(operator.id, !operator.isActive, fd);
    if (r.success) {
      showToast({ tone: "success", title: "Done", description: r.success });
      setMode(null);
      router.refresh();
    }
    return r;
  }, {});
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium">{operator.name}</span> <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">{operator.username}</span>
          {isMe ? <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">(you)</span> : null}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {operator.canSupport ? <Badge color="blue">Support access</Badge> : null}
          {!operator.isActive ? <Badge color="gray">Deactivated</Badge> : null}
          <span className="text-xs text-[color:var(--color-muted-foreground)]">{operator.lastLoginAt ? `last sign-in ${new Date(operator.lastLoginAt).toLocaleDateString()}` : "never signed in"}</span>
          <Button size="sm" variant="ghost" onClick={() => setMode(mode === "password" ? null : "password")}>
            Password
          </Button>
          {!isMe ? (
            <Button size="sm" variant="ghost" onClick={() => setMode(mode === "toggle" ? null : "toggle")}>
              {operator.isActive ? "Deactivate" : "Reactivate"}
            </Button>
          ) : null}
        </span>
      </div>
      {mode ? (
        <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
          {mode === "password" ? <Input name="newPassword" type="password" autoComplete="new-password" placeholder="New password (12+ characters)" className="w-60" required /> : null}
          <Input name="operatorPassword" type="password" autoComplete="current-password" placeholder="Your platform password" className="w-52" required />
          <Button type="submit" size="sm" loading={pending}>
            {mode === "password" ? "Set password" : operator.isActive ? "Deactivate" : "Reactivate"}
          </Button>
          {state.error ? <span className="w-full text-xs text-[color:var(--color-danger-fg)]">{state.error}</span> : null}
        </form>
      ) : null}
    </li>
  );
}

function AddOperator({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<OperatorActionResult, FormData>(async (_prev, fd) => {
    const r = await createOperator({}, fd);
    if (r.success) router.refresh();
    return r;
  }, {});
  const e = state.fieldErrors ?? {};
  if (state.success) {
    return (
      <Alert tone="success" title="Operator added">
        {state.success}{" "}
        <button type="button" className="font-medium underline" onClick={onDone}>
          Close
        </button>
      </Alert>
    );
  }
  return (
    <form action={action} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="op-name" error={e.name}>
          <Input id="op-name" name="name" required maxLength={120} />
        </Field>
        <Field label="Username" htmlFor="op-user" error={e.username}>
          <Input id="op-user" name="username" required autoComplete="off" />
        </Field>
        <Field label="Email" htmlFor="op-email">
          <Input id="op-email" name="email" type="email" />
        </Field>
        <Field label="Password" htmlFor="op-pass" error={e.password} hint="12+ characters. Share it privately.">
          <Input id="op-pass" name="password" type="password" autoComplete="new-password" required />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="canSupport" defaultChecked className="mt-1" />
        <span>May enter customers&apos; software through support access</span>
      </label>
      <Field label="Your platform password" htmlFor="op-confirm">
        <Input id="op-confirm" name="operatorPassword" type="password" autoComplete="current-password" required />
      </Field>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Add operator
        </Button>
      </div>
    </form>
  );
}
