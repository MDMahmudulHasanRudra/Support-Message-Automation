"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, Card, ConfirmDialog, ModuleCardRow } from "@/components/ui";
import { disconnectTeamsAccount, triggerTeamsSyncNow } from "@/server/actions/teamsIntegration";

export interface TeamsConnectionInfo {
  configured: boolean;
  status: string;
  email: string | null;
  displayName: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  teamsCount: number;
  channelsCount: number;
  messagesCount: number;
}

const STATUS_BADGE: Record<string, { color: "green" | "gray" | "red" | "yellow" | "blue"; label: string; pulse?: boolean }> = {
  CONNECTED: { color: "green", label: "Connected" },
  SYNCING: { color: "blue", label: "Synchronizing…", pulse: true },
  DISCONNECTED: { color: "gray", label: "Not connected" },
  ERROR: { color: "red", label: "Needs attention" },
  REAUTH_REQUIRED: { color: "yellow", label: "Reconnect needed" },
};

export function TeamsConnectionCard({ info }: { info: TeamsConnectionInfo }) {
  const router = useRouter();
  const [isDisconnecting, startDisconnect] = useTransition();
  const [isSyncing, startSync] = useTransition();
  const [isNavigatingToConnect, setIsNavigatingToConnect] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  function disconnect() {
    startDisconnect(async () => {
      await disconnectTeamsAccount();
      setConfirmDisconnect(false);
      router.refresh();
    });
  }

  function syncNow() {
    startSync(async () => {
      await triggerTeamsSyncNow();
      router.refresh();
    });
  }

  if (!info.configured) {
    return (
      <Card>
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          Microsoft Teams integration is not configured yet. This is a one-time step for whoever
          manages this deployment — see{" "}
          <code className="rounded bg-[var(--color-neutral-bg)] px-1 py-0.5 text-xs">TEAMS_SETUP.md</code> for the exact
          Azure App Registration steps. Nothing here needs Client IDs, secrets, or tenant IDs from
          you personally.
        </p>
      </Card>
    );
  }

  const badge = STATUS_BADGE[info.status] ?? STATUS_BADGE.DISCONNECTED!;
  const isConnected = info.status === "CONNECTED" || info.status === "SYNCING";
  const needsReconnect = info.status === "ERROR" || info.status === "REAUTH_REQUIRED";

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <Badge color={badge.color} dot pulse={badge.pulse}>
          {badge.label}
        </Badge>
        {isConnected ? (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" loading={isSyncing} onClick={syncNow}>
              Sync Now
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </Button>
          </div>
        ) : (
          <a href="/api/teams/connect" onClick={() => setIsNavigatingToConnect(true)}>
            <Button size="sm" loading={isNavigatingToConnect}>
              {needsReconnect ? "Reconnect Microsoft Teams" : "Connect Microsoft Teams"}
            </Button>
          </a>
        )}
      </div>

      {isConnected ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <ModuleCardRow label="Account">{info.displayName ?? info.email ?? "—"}</ModuleCardRow>
            {info.email ? <ModuleCardRow label="Email">{info.email}</ModuleCardRow> : null}
            <ModuleCardRow label="Last Sync">{info.lastSyncAt ?? "Just now"}</ModuleCardRow>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)]/50 p-3 text-center">
            <div>
              <p className="text-lg font-semibold tabular-nums">{info.teamsCount}</p>
              <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Teams</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">{info.channelsCount}</p>
              <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Channels</p>
            </div>
            <div>
              <p className="text-lg font-semibold tabular-nums">{info.messagesCount}</p>
              <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Messages Synced</p>
            </div>
          </div>
          <Link href="/integrations/teams/manage" className="link text-xs font-medium">
            Manage Teams &amp; Channels →
          </Link>
        </div>
      ) : needsReconnect ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          Microsoft Teams needs to be reconnected — your authorization expired or was revoked.
          Reconnecting takes a few seconds and won&apos;t lose any synced history.
        </p>
      ) : (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          Connect your Microsoft Teams account to synchronize developer conversations and automate
          resolution notifications. You&apos;ll sign in securely on Microsoft&apos;s own login
          page — this application never sees your Microsoft password.
        </p>
      )}

      {info.lastSyncError && needsReconnect ? (
        <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-2.5 text-xs text-[color:var(--color-danger-fg)]">
          Microsoft Teams synchronization has stopped.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        loading={isDisconnecting}
        tone="danger"
        title="Disconnect Microsoft Teams?"
        description="This stops synchronization and Teams-based automation. Your existing Issue history and synced messages remain available — nothing is deleted."
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
