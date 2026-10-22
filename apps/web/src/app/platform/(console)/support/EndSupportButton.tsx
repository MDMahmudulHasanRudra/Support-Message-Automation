"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, useToast } from "@/components/ui";
import { endSupportAccess } from "@/server/platform/actions/support";

export function EndSupportButton({ id }: { id: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await endSupportAccess(id);
          showToast({ tone: r.error ? "danger" : "success", title: r.error ? "Not done" : "Done", description: r.error ?? r.success ?? "" });
          router.refresh();
        })
      }
    >
      End now
    </Button>
  );
}
