"use client";

import { useActionState } from "react";
import { Button, Card } from "@/components/ui";
import { sendTestNotification, type TestNotificationState } from "@/server/actions/notifications";

export function TestNotificationForm() {
  const [state, formAction, pending] = useActionState<TestNotificationState, FormData>(sendTestNotification, {});

  return (
    <Card className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Send Test Notification</h2>
      <form action={formAction} className="flex gap-2">
        <input
          name="message"
          placeholder="Test message"
          defaultValue="This is a test notification from the dashboard."
          className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Queuing..." : "Send Test"}
        </Button>
      </form>
      {state.success ? <p className="mt-2 text-sm text-green-600">Queued — check the table below.</p> : null}
      {state.error ? <p className="mt-2 text-sm text-red-600">{state.error}</p> : null}
    </Card>
  );
}
