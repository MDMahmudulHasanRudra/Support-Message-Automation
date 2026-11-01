"use client";

import { useEffect } from "react";
import { Card, ErrorState } from "@/components/ui";

/**
 * The error boundary for every Main Admin Portal page, the portal's copy of the dashboard's
 * (`p/[project]/(dashboard)/error.tsx`). Without it a failure fell through to the framework's own
 * screen, outside the portal and its navigation. The message itself is never shown — internal detail
 * must not surface in the UI — only the digest, which is the one handle a person can quote.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[main-admin] unhandled page error", error);
  }, [error]);

  return (
    <Card>
      <ErrorState
        title="Something went wrong on this page."
        description={
          error.digest
            ? `The rest of the portal still works. Try again; if it keeps happening, quote reference ${error.digest} when you report it.`
            : "The rest of the portal still works. Try again; if it keeps happening, check the System Logs."
        }
        onRetry={reset}
      />
    </Card>
  );
}
