"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { QrCode } from "lucide-react";
import {
  Badge,
  type BadgeColor,
  Button,
  Card,
  ConfirmDialog,
  useToast,
} from "@/components/ui";
import { QrConnectDialog } from "./QrConnectDialog";

/** What the operator should do next, per status — the card's job is to answer that, not just report state. */
const STATUS_HINT: Record<string, string> = {
  CONNECTED: "Sending and receiving normally.",
  DISCONNECTED: "Not linked to a phone. Connect to scan a QR code.",
  RECONNECTING: "The worker is bringing this session back up.",
  AUTHENTICATION_REQUIRED: "Waiting for a QR scan on the phone.",
  SESSION_ERROR: "The session broke. Reconnect, and log out first if that does not clear it.",
  OUTBOUND_PAUSED: "Receiving, but not sending.",
  RATE_LIMITED: "Holding back sends to protect the number.",
  ERROR: "Something went wrong. Check System Logs for the reason.",
};

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
  const [qrOpen, setQrOpen] = useState(false);
  const previousStatus = useRef(account.status);

  const needsScan = account.status === "AUTHENTICATION_REQUIRED";
  const isConnected = account.status === "CONNECTED";

  /**
   * Opens on the transition *into* a scannable state, not on every render where one exists.
   *
   * The page polls while a QR is live and the code itself rotates every few seconds, so
   * re-opening whenever a code is present would reopen the dialog seconds after the operator
   * closed it. Reacting to the edge means it appears exactly once per linking attempt, and
   * closing it stays closed.
   */
  useEffect(() => {
    const wasNeedingScan = previousStatus.current === "AUTHENTICATION_REQUIRED";
    const justStartedNeedingScan = !wasNeedingScan && account.status === "AUTHENTICATION_REQUIRED";
    const justConnected = wasNeedingScan && account.status === "CONNECTED";
    previousStatus.current = account.status;

    if (justStartedNeedingScan) queueMicrotask(() => setQrOpen(true));
    if (justConnected) {
      showToast({ tone: "success", title: `${account.label} connected` });
      // Left open for a beat so the success state is actually seen, rather than the dialog
      // vanishing at the same instant the phone says "linked".
      const timer = setTimeout(() => setQrOpen(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [account.status, account.label, showToast]);

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
          <dt className="text-xs text-[color:var(--color-muted-foreground)]">Worker last seen</dt>
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

      {STATUS_HINT[account.status] ? (
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
          {STATUS_HINT[account.status]}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* When an account is not linked, connecting is the only thing anyone came here to do —
            so it is the one filled button, rather than a fifth equal-weight option. */}
        {!isConnected ? (
          <Button
            onClick={() => {
              // Already trying? Show the dialog so the operator can watch for the code, rather
              // than asking them to confirm a second reconnect on top of the one in flight.
              if (needsScan || account.status === "RECONNECTING") setQrOpen(true);
              else setDialog("reconnect");
            }}
          >
            <QrCode className="size-3.5" aria-hidden />
            {needsScan ? "Show QR code" : account.status === "RECONNECTING" ? "Watch for QR" : "Connect"}
          </Button>
        ) : null}
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

      <QrConnectDialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        account={account}
        reconnectPending={isPending}
        onReconnect={() =>
          startTransition(async () => {
            await onReconnect();
            showToast({ tone: "info", title: "New code requested" });
          })
        }
      />

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
