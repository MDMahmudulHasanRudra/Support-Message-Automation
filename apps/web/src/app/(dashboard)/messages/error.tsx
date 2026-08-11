"use client";

import { Card, ErrorState } from "@/components/ui";

export default function MessagesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <ErrorState
        title="Could not load messages."
        description={error.digest ? `Reference: ${error.digest}` : "Please try again, or adjust your filters."}
        onRetry={reset}
      />
    </Card>
  );
}
