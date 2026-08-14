"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Tooltip } from "@/components/ui";
import { triggerAiAnalysisBatch } from "@/server/actions/learning";

export function RunAiAnalysisButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      await triggerAiAnalysisBatch();
      router.refresh();
    });
  }

  const button = (
    <Button variant="secondary" size="sm" onClick={run} loading={pending} disabled={!enabled || pending}>
      Run AI Analysis Now
    </Button>
  );

  if (enabled) return button;

  return (
    <Tooltip content="Requires AI Engine + Learning enabled in AI Settings, with an active provider assigned to the Learning job in AI Models.">
      {button}
    </Tooltip>
  );
}
