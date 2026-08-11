"use client";

import { useActionState, useEffect } from "react";
import { Button, Card, Input, SectionHeader, useToast } from "@/components/ui";
import { sendTestNotification, type TestNotificationState } from "@/server/actions/notifications";

export function TestNotificationForm() {
  const [state, formAction, pending] = useActionState<TestNotificationState, FormData>(sendTestNotification, {});
  const { showToast } = useToast();

  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: "Test notification queued", description: "Check the table below." });
    } else if (state.error) {
      showToast({ tone: "danger", title: "Could not queue test notification", description: state.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <Card className="mb-6">
      <SectionHeader title="Send Test Notification" />
      <form action={formAction} className="flex gap-2">
        <Input
          name="message"
          placeholder="Test message"
          defaultValue="This is a test notification from the dashboard."
          className="flex-1"
        />
        <Button type="submit" loading={pending}>
          Send Test
        </Button>
      </form>
    </Card>
  );
}
