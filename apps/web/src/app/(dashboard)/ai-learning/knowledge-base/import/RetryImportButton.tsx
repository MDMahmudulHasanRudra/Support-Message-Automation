"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { retryKnowledgeImport } from "@/server/actions/knowledgeImport";

/** Re-queues an import against the text it already holds — no need to find the file again. */
export function RetryImportButton({ importId }: { importId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          await retryKnowledgeImport(importId);
          router.refresh();
        })
      }
    >
      Retry
    </Button>
  );
}
