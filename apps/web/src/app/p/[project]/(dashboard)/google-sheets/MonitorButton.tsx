"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Badge, Button, useToast } from "@/components/ui";
import { setSpreadsheetMonitoringAction } from "@/server/actions/googleSheets";

/** Monitor / stop monitoring one spreadsheet. Shows the state, and the action beside it. */
export function MonitorButton({ spreadsheetId, monitored }: { spreadsheetId: string; monitored: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useState(monitored);

  function toggle() {
    const next = !shown;
    startTransition(async () => {
      const result = await setSpreadsheetMonitoringAction(spreadsheetId, next);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      setShown(next);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {shown ? (
        <Badge color="green" dot>
          Monitored
        </Badge>
      ) : null}
      <Button size="sm" variant={shown ? "ghost" : "secondary"} loading={pending} onClick={toggle}>
        {shown ? "Stop" : "Monitor"}
      </Button>
    </div>
  );
}
