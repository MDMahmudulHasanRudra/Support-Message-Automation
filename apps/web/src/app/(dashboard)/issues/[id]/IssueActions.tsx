"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { closeSupportIssue, markSupportIssueResolved, reopenSupportIssue } from "@/server/actions/issues";

export function IssueActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      await action();
      router.refresh();
    });
  }

  const isTerminal = status === "CLOSED";

  return (
    <div className="flex flex-wrap gap-2">
      {status !== "RESOLVED" && !isTerminal ? (
        <Button size="sm" loading={pending} onClick={() => run(() => markSupportIssueResolved(id))}>
          Mark Resolved
        </Button>
      ) : null}
      {status === "RESOLVED" ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => reopenSupportIssue(id))}>
          Reopen
        </Button>
      ) : null}
      {!isTerminal ? (
        <Button variant="danger" size="sm" loading={pending} onClick={() => run(() => closeSupportIssue(id))}>
          Close
        </Button>
      ) : null}
    </div>
  );
}
