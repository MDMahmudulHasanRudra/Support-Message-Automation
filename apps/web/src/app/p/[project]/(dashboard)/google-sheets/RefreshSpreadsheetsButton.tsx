"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, useToast } from "@/components/ui";
import { refreshAllGoogleSpreadsheetsAction } from "@/server/actions/googleSheets";

/** Read every connected account's spreadsheet list from Google again (file details only). */
export function RefreshSpreadsheetsButton() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="secondary"
      size="md"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshAllGoogleSpreadsheetsAction();
          if (result.error) showToast({ tone: "danger", title: result.error });
          else showToast({ tone: "success", title: result.success ?? "Done" });
          router.refresh();
        })
      }
    >
      <RefreshCw className="size-4" aria-hidden />
      Refresh from Google
    </Button>
  );
}
