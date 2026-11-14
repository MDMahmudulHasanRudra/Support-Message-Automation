"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { launchBusinessApp } from "@/server/actions/businessApps";

/**
 * Asks the server for a short-lived, single-use launch and, only then, sends the browser to the app's own
 * address as a top-level navigation — never an iframe, and nothing of this app's session goes with it.
 */
export function LaunchButton({ appKey, appName }: { appKey: string; appName: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <Button
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await launchBusinessApp(appKey);
            if (result.redirectUrl) window.location.assign(result.redirectUrl);
            else setError(result.error ?? `${appName} could not be opened.`);
          })
        }
      >
        Open {appName}
        <ExternalLink className="size-4" aria-hidden />
      </Button>
      {error ? <Alert tone="warning">{error}</Alert> : null}
    </div>
  );
}
