"use client";

import { useActionState, useEffect, useRef } from "react";
import { Alert, Button } from "@/components/ui";
import { consumeSupportTicket, type SupportTicketState } from "./actions";

export function ContinueSupport({ ticket }: { ticket: string }) {
  const [state, action, pending] = useActionState<SupportTicketState, FormData>(() => consumeSupportTicket(ticket), {});
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, []);
  return (
    <form ref={form} action={action} className="space-y-3">
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {!state.error ? (
        <Button type="submit" loading={pending} className="w-full">
          Continue
        </Button>
      ) : null}
    </form>
  );
}
