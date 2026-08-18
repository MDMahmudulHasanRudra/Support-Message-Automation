"use client";

import { useState, useTransition } from "react";
import {
  Badge,
  type BadgeColor,
  Button,
  Card,
  ConfirmDialog,
  StatusDot,
  useToast,
} from "@/components/ui";

const STATUS_COLOR: Record<string, BadgeColor> = {
  CONNECTED: "green",
  DISCONNECTED: "gray",
  RECONNECTING: "blue",
  AUTHENTICATION_REQUIRED: "yellow",
  SESSION_ERROR: "red",
  OUTBOUND_PAUSED: "yellow",
  RATE_LIMITED: "yellow",
  ERROR: "red",
};

export interface AccountCardData {
  id: string;
  label: string;
  phoneNumber: string | null;
  status: string;
  isPrimary: boolean;
  usedByServices: string[];
  canDelete: boolean;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  sessionDataPath: string | null;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  qrStale: boolean;
}

type DialogKind = "reconnect" | "resync" | "logout" | "setPrimary" | "removePrimary" | "delete" | null;

export function AccountCard({
  account,
  onReconnect,
  onResync,
  onLogout,
  onSetPrimary,
  onRemovePrimary,
  onDelete,
}: {
  account: AccountCardData;
  onReconnect: () => Promise<void>;
  onResync: () => Promise<void>;
  onLogout: () => Promise<void>;
  onSetPrimary: () => Promise<void>;
  onRemovePrimary: () => Promise<void>;
  onDelete: () => Promise<{ error?: string }>;
}) {
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const closeDialog = () => {
    setDialog(null);
    setDeleteError(null);
  };

  function confirmReconnect() {
    startTransition(async () => {
      await onReconnect();
      closeDialog();
      showToast({
        tone: "info",
        title: "Reconnect requested",
        description: "The worker will pick this up shortly.",
      });
    });
  }

  function confirmResync() {
    startTransition(async () => {
      await onResync();
      closeDialog();
      showToast({
        tone: "info",
        title: "Group resync requested",
        description: "The worker will pick this up shortly.",
      });
    });
  }

  function confirmLogout() {
    startTransition(async () => {
      await onLogout();
      closeDialog();
      showToast({
        tone: "success",
        title: "Logout requested",
        description: "Waiting for the worker to process it.",
      });
    });
  }

  function confirmSetPrimary() {
    startTransition(async () => {
      await onSetPrimary();
      closeDialog();
      showToast({
        tone: "success",
        title: "Primary account changed",
        description: `"${account.label}" is now the default account for all unconfigured services.`,
      });
    });
  }

  function confirmRemovePrimary() {
    startTransition(async () => {
      await onRemovePrimary();
      closeDialog();
      showToast({
        tone: "info",
        title: "Primary status removed",
        description: "No account is Primary now — unconfigured services will error until one is set.",
      });
    });
  }

  function confirmDelete() {
    startTransition(async () => {
      const result = await onDelete();
      if (result.error) {
        setDeleteError(result.error);
        return;
      }
      closeDialog();
      showToast({
        tone: "success",
        title: "Account deleted",
        description: `"${account.label}" and its synced data have been removed.`,
      });
    });
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[color:var(--color-foreground)]">
              {account.label}
            </h2>
            {account.isPrimary ? <Badge color="blue">Primary</Badge> : null}
          </div>
          <p className="font-[family-name:var(--font-mono)] text-sm text-[color:var(--color-muted-foreground)]">
            {account.phoneNumber ?? "(number not yet known)"}
          </p>
        </div>
        <Badge color={STATUS_COLOR[account.status] ?? "gray"} dot>
          {account.status}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs text-[color:var(--color-muted-foreground)]">Last connected</dt>
          <dd className="mt-0.5 text-[color:var(--color-foreground)]">
            {account.lastConnectedAt ? new Date(account.lastConnectedAt).toLocaleString() : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[color:var(--color-muted-foreground)]">Last heartbeat</dt>
          <dd className="mt-0.5 text-[color:var(--color-foreground)]">
            {account.lastHeartbeatAt ? new Date(account.lastHeartbeatAt).toLocaleString() : "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-[color:var(--color-muted-foreground)]">Session path</dt>
          <dd className="mt-0.5 truncate font-[family-name:var(--font-mono)] text-xs text-[color:var(--color-foreground)]">
            {account.sessionDataPath ?? "—"}
          </dd>
        </div>
      </dl>

      {account.usedByServices.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Explicitly used by: <span className="text-[color:var(--color-foreground)]">{account.usedByServices.join(", ")}</span>
          </p>
        </div>
      ) : account.isPrimary ? (
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
          Default account for every service not explicitly configured otherwise.
        </p>
      ) : null}

      {account.status === "AUTHENTICATION_REQUIRED" && account.qrCode ? (
        <div className="mt-4">
          {account.qrStale ? (
            <div className="flex h-56 w-56 flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] text-center text-sm text-[color:var(--color-muted-foreground)]">
              Waiting for a fresh QR code…
              <span className="mt-1 text-xs">(previous code expired)</span>
            </div>
          ) : (
            <>
              <p className="mb-2 text-sm font-medium text-[color:var(--color-foreground)]">
                Scan this QR code with WhatsApp:
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={account.qrCode}
                alt="WhatsApp QR code"
                className="h-56 w-56 rounded-[var(--radius-md)] border border-[var(--color-border)]"
              />
            </>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)]">
            <span>
              Updated {account.qrUpdatedAt ? new Date(account.qrUpdatedAt).toLocaleTimeString() : "—"} · this
              page refreshes automatically
            </span>
            <StatusDot color="blue" pulse />
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setDialog("reconnect")}>
          Reconnect
        </Button>
        <Button variant="secondary" onClick={() => setDialog("resync")}>
          Resync Groups
        </Button>
        {account.isPrimary ? (
          <Button variant="secondary" onClick={() => setDialog("removePrimary")}>
            Remove Primary
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setDialog("setPrimary")}>
            Set as Primary
          </Button>
        )}
        <Button variant="danger" onClick={() => setDialog("logout")}>
          Logout
        </Button>
        {account.canDelete ? (
          <Button variant="ghost" onClick={() => setDialog("delete")}>
            Delete
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={dialog === "reconnect"}
        onClose={closeDialog}
        onConfirm={confirmReconnect}
        loading={isPending}
        title="Reconnect this account?"
        description="Sends a reconnect command to the worker for this WhatsApp account."
        confirmLabel="Reconnect"
      />

      <ConfirmDialog
        open={dialog === "resync"}
        onClose={closeDialog}
        onConfirm={confirmResync}
        loading={isPending}
        title="Resync groups?"
        description="Sends a group-resync command to the worker. This refreshes the group list from WhatsApp and does not change monitoring settings."
        confirmLabel="Resync Groups"
      />

      <ConfirmDialog
        open={dialog === "logout"}
        onClose={closeDialog}
        onConfirm={confirmLogout}
        loading={isPending}
        title="Logout this WhatsApp account?"
        description="You will need to scan a new QR code with a phone to reconnect — the current session cannot be restored automatically."
        confirmLabel="Logout"
        tone="danger"
      />

      <ConfirmDialog
        open={dialog === "setPrimary"}
        onClose={closeDialog}
        onConfirm={confirmSetPrimary}
        loading={isPending}
        title="Set as Primary account?"
        description="Every WhatsApp-dependent service without its own account configured will start using this account by default, instead of the current Primary."
        confirmLabel="Set as Primary"
      />

      <ConfirmDialog
        open={dialog === "removePrimary"}
        onClose={closeDialog}
        onConfirm={confirmRemovePrimary}
        loading={isPending}
        title="Remove Primary status?"
        description="No account will be Primary afterward. Any service that isn't explicitly configured with its own account will show a clear error instead of sending, until a new Primary is set."
        confirmLabel="Remove Primary"
        tone="danger"
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onClose={closeDialog}
        onConfirm={confirmDelete}
        loading={isPending}
        title="Delete this WhatsApp account?"
        description={
          deleteError ??
          "This permanently removes the account along with its synced groups and message history. This cannot be undone."
        }
        confirmLabel="Delete"
        tone="danger"
      />
    </Card>
  );
}
