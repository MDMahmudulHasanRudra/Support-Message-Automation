"use client";

import { useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, Switch } from "@/components/ui";
import { disconnectSocialConnectionAction, refreshSocialConnectionAction, setSocialAccountEnabledAction, type SocialAccountsState } from "@/server/actions/socialAccounts";

export function ConnectionControls({ connectionId }: { connectionId: string }) {
  const router = useProjectRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SocialAccountsState>({});
  const run = (fn: () => Promise<SocialAccountsState>) =>
    start(async () => {
      setResult(await fn());
      router.refresh();
    });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={pending} onClick={() => run(() => refreshSocialConnectionAction(connectionId))}>
          Check and refresh accounts
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={pending}
          onClick={() => (window.confirm("Disconnect? Its accounts stop publishing here; scheduled posts for them will fail until they are connected again.") ? run(() => disconnectSocialConnectionAction(connectionId)) : undefined)}
        >
          Disconnect
        </Button>
      </div>
      {result.error ? <p className="text-xs text-[color:var(--color-danger)]">{result.error}</p> : null}
      {result.success ? <p className="text-xs text-[color:var(--color-success-fg)]">{result.success}</p> : null}
    </div>
  );
}

export function AccountSwitch({ accountId, enabled, disabled }: { accountId: string; enabled: boolean; disabled: boolean }) {
  const router = useProjectRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Switch
        checked={enabled}
        disabled={disabled || pending}
        aria-label={enabled ? "Switch off for publishing" : "Switch on for publishing"}
        onChange={(e) => {
          const next = e.target.checked;
          start(async () => {
            const r = await setSocialAccountEnabledAction(accountId, next);
            setError(r.error ?? null);
            router.refresh();
          });
        }}
      />
      {error ? <span className="text-xs text-[color:var(--color-danger)]">{error}</span> : null}
    </span>
  );
}
