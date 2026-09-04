"use client";

import { useEffect } from "react";
import { Card, ErrorState } from "@/components/ui";

/**
 * The error boundary for every dashboard page.
 *
 * Before this, exactly one route (`messages`) had one, so a failure anywhere else fell through to
 * the framework's own error screen — a bare stack trace on a white page, outside the product, with
 * no way back except the browser's back button. On an operations console that is the worst moment
 * to lose the navigation.
 *
 * A page may still add its own `error.tsx` for a more specific message; Next uses the nearest one.
 * This is the floor, not a replacement for that.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle a person has when reporting this, and the message itself is
    // never shown to them — internal detail must not surface in the UI (ENGINEERING_STANDARDS).
    console.error("[dashboard] unhandled page error", error);
  }, [error]);

  return (
    <Card>
      <ErrorState
        title="Something went wrong on this page."
        description={
          error.digest
            ? `The rest of the console is still working. Quote reference ${error.digest} if you report this.`
            : "The rest of the console is still working. Try again, and if it keeps happening, check the Logs page."
        }
        onRetry={reset}
      />
    </Card>
  );
}
