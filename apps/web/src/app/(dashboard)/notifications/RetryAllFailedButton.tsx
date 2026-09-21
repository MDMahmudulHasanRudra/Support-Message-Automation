"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Alert, Button, ConfirmDialog } from "@/components/ui";
import { retryAllFailedNotifications, type BulkRetryResult } from "@/server/actions/notifications";

/**
 * One action for what is almost always one cause.
 *
 * A rotated Teams webhook or a WhatsApp session that dropped for ten minutes fails every alert
 * raised in that window, so this log fills with rows that share a cause and a fix — and the only
 * remedy was a Retry click per row. Confirmed rather than instant, because requeuing several
 * hundred alerts puts them all back in front of the team at once.
 */
export function RetryAllFailedButton({ failedCount }: { failedCount: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkRetryResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (failedCount === 0) return null;

  function run() {
    setConfirming(false);
    startTransition(async () => {
      setResult(await retryAllFailedNotifications());
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" loading={pending} onClick={() => setConfirming(true)}>
        <RefreshCw className="size-3.5" aria-hidden />
        Retry all {failedCount.toLocaleString()} failed
      </Button>

      {result ? (
        <div className="mt-2 w-full">
          <Alert
            tone={result.error ? "danger" : "success"}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Dismiss
              </Button>
            }
          >
            {result.error ?? `${result.requeued.toLocaleString()} requeued — the dispatcher picks them up within seconds.`}
          </Alert>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={run}
        loading={pending}
        title={`Retry ${failedCount.toLocaleString()} failed notification${failedCount === 1 ? "" : "s"}?`}
        description="Each one resends the exact message that was stored when it was raised — it does not re-run the rule behind it. Fix the cause first, or they will fail again."
        confirmLabel="Retry all"
      />
    </>
  );
}
