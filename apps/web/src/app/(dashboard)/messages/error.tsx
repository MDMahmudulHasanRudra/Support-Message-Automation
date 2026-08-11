"use client";

import { Button, Card } from "@/components/ui";

export default function MessagesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <p className="mb-2 text-sm font-medium text-red-600">Could not load messages.</p>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        {error.digest ? `Reference: ${error.digest}` : "Please try again, or adjust your filters."}
      </p>
      <Button onClick={() => reset()}>Retry</Button>
    </Card>
  );
}
