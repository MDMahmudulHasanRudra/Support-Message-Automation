"use client";

import type { AccountHistoryImpact } from "@support-automation/db";
import type { DeleteAccountResult } from "@/server/actions/accounts";
import { useEffect, useRef, useState, useTransition } from "react";
import { QrCode } from "lucide-react";
import {
  Badge,
  type BadgeColor,
  Button,
  Card,
  ConfirmDialog,
  StatusDot,
  useToast,
} from "@/components/ui";
import { QrConnectDialog, type PairingMethod } from "./QrConnectDialog";
import { describeConnectionStage } from "@/lib/connectionStage";
import { AccountAdvancedDialog } from "./AccountAdvancedDialog";

/** What the operator should do next, per status — the card's job is to answer that, not just report state. */
const STATUS_HINT: Record<string, string> = {
  CONNECTED: "Sending and receiving normally.",
  DISCONNECTED: "Not linked to a phone. Connect to scan a QR code, or link by phone number.",
  // This line used to read "The worker is bringing this session back up." It was a promise nothing
  // kept: RECONNECTING is not a step on the way to CONNECTED, it is every pre-connected state
  // rolled into one, and nothing recovered an account that got stuck there. On 18 Sep 2026 a
  // number sat in exactly this state for three hours while the dashboard said it was being fixed,
  // which is worse than saying nothing — somebody read it and waited.
  RECONNECTING: "Connecting. Not receiving customer messages while this lasts — if it stays here for more than a few minutes, press Reconnect.",
  AUTHENTICATION_REQUIRED: "Waiting for a QR scan on the phone. Not receiving customer messages until it is linked.",
  SESSION_ERROR: "The session broke. Reconnect, and log out first if that does not clear it.",
  // OUTBOUND_PAUSED and RATE_LIMITED used to sit here, with hints describing a per-account
  // throttling mechanism that has never existed — nothing in the codebase ever wrote either
  // status. Throttling in this system is per outbound MESSAGE, and that one is real and shown in
  // the chat inbox. Both are now gone from the enum as well.
  ERROR: "Something went wrong. Check System Logs for the reason.",
};

const STATUS_COLOR: Record<string, BadgeColor> = {
  CONNECTED: "green",
  DISCONNECTED: "gray",
  RECONNECTING: "blue",
  AUTHENTICATION_REQUIRED: "yellow",
  SESSION_ERROR: "red",
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
  /** The provider's fine-grained lifecycle state. Reported to the operator; nothing branches on it. */
  connectionStage: string | null;
  /** A QR data URL or a nine-character link code, depending on `pairingMethod`. */
  qrCode: string | null;
  qrUpdatedAt: string | null;
  qrStale: boolean;
  pairingMethod: PairingMethod;
  pairingPhoneNumber: string | null;
  /** `host:port`, or null when this account connects directly. Shown so a saved proxy is not an invisible setting. */
  proxyAddress: string | null;
}

type DialogKind = "reconnect" | "resync" | "logout" | "setPrimary" | "removePrimary" | "delete" | "advanced" | null;

export function AccountCard({
  account,
  onReconnect,
  onResync,
  onLogout,
  onSetPrimary,
  onRemovePrimary,
  onDelete,
  onReadDeletionImpact,
}: {
  account: AccountCardData;
  onReconnect: () => Promise<void>;
  onResync: () => Promise<void>;
  onLogout: () => Promise<void>;
  onSetPrimary: () => Promise<void>;
  onRemovePrimary: () => Promise<void>;
  onDelete: (confirmDestroyHistory?: boolean) => Promise<DeleteAccountResult>;
  /** Read-only: what a delete would destroy, so the confirmation can name real numbers. */
  onReadDeletionImpact: () => Promise<AccountHistoryImpact>;
}) {
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletionImpact, setDeletionImpact] = useState<AccountHistoryImpact | null>(null);
  const [isPending, startTransition] = useTransition();
  const [qrOpen, setQrOpen] = useState(false);
  const previousStatus = useRef(account.status);
  /**
   * Set when this operator asks for a logout, so the DISCONNECTED that follows can be reported as
   * "done" rather than mistaken for one. Not every DISCONNECTED is a completed logout — a dropped
   * session lands on the same status — and congratulating somebody on an outage would be worse
   * than saying nothing.
   */
  const logoutRequested = useRef(false);

  const needsScan = account.status === "AUTHENTICATION_REQUIRED";
  const isConnected = account.status === "CONNECTED";
  const stage = describeConnectionStage(account.connectionStage);

  /**
   * Opens on the transition *into* a scannable state, not on every render where one exists.
   *
   * The page polls while a QR is live and the code itself rotates every few seconds, so
   * re-opening whenever a code is present would reopen the dialog seconds after the operator
   * closed it. Reacting to the edge means it appears exactly once per linking attempt, and
   * closing it stays closed.
   */
  useEffect(() => {
    const previous = previousStatus.current;
    const justStartedNeedingScan =
      previous !== "AUTHENTICATION_REQUIRED" && account.status === "AUTHENTICATION_REQUIRED";
    // Any pre-connected state counts as "was linking", not AUTHENTICATION_REQUIRED alone. A link
    // code attempt passes through RECONNECTING on its way to CONNECTED and a restored session
    // never shows a code at all, so keying the success toast to the scan state meant the two
    // paths that do not involve staring at a QR produced no confirmation whatsoever.
    const justConnected = previous !== "CONNECTED" && account.status === "CONNECTED";
    const justLoggedOut =
      logoutRequested.current && previous !== "DISCONNECTED" && account.status === "DISCONNECTED";
    previousStatus.current = account.status;

    if (justStartedNeedingScan) queueMicrotask(() => setQrOpen(true));

    if (justLoggedOut) {
      logoutRequested.current = false;
      // The request toast said the worker had been ASKED. This one says it actually happened —
      // the difference between the two is a command sitting in a queue nothing is draining, which
      // is precisely the failure this page exists to make visible.
      showToast({
        tone: "success",
        title: `${account.label} logged out`,
        description: "The session is closed. Its groups are inactive until a number links again.",
      });
    }

    if (justConnected) {
      showToast({
        tone: "success",
        title: `${account.label} connected`,
        description: account.phoneNumber ? `Linked as +${account.phoneNumber}.` : undefined,
      });
      // Left open for a beat so the success state is actually seen, rather than the dialog
      // vanishing at the same instant the phone says "linked". Longer than it was, because the
      // dialog now confirms WHICH number linked and that is worth reading before it goes.
      const timer = setTimeout(() => setQrOpen(false), 3500);
      return () => clearTimeout(timer);
    }
  }, [account.status, account.label, account.phoneNumber, showToast]);

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
      logoutRequested.current = true;
      closeDialog();
      showToast({
        tone: "info",
        title: "Logging out",
        description: "Sent to the worker. This card will confirm when the session is actually closed.",
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

  /**
   * Opening the dialog reads what the delete would take. The figures are fetched rather than
   * guessed because the previous copy — "synced groups and message history" — described about a
   * third of the fourteen relations that cascade off this row, and a confirmation that
   * misdescribes what it is about to do is worse than no confirmation.
   */
  function openDeleteDialog() {
    setDeleteError(null);
    setDeletionImpact(null);
    setDialog("delete");
    void onReadDeletionImpact()
      .then(setDeletionImpact)
      // A failed count must not block the dialog: the server refuses an unconfirmed delete on an
      // account with history anyway, so the safe path holds either way.
      .catch(() => setDeletionImpact(null));
  }

  function confirmDelete() {
    startTransition(async () => {
      // The operator has read the figures by the time this button is reachable, which is exactly
      // what the server is asking to be told.
      const result = await onDelete(true);
      if (result.error) {
        setDeleteError(result.error);
        if (result.impact) setDeletionImpact(result.impact);
        return;
      }
      closeDialog();
      const destroyed = result.destroyed;
      showToast({
        tone: "success",
        title: "Account deleted",
        description: destroyed?.hasHistory
          ? `"${account.label}" is gone, with ${destroyed.messages.toLocaleString()} messages and ${destroyed.groups.toLocaleString()} groups.`
          : `"${account.label}" has been removed. It held no history.`,
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

      {/* Where the attempt has actually got to, above the advice about the status it is inside.
          The badge says RECONNECTING for a browser launch, a page load, a live code and an
          accepted scan alike; this is the line that tells those four apart. Only while there is
          something in motion — on a settled account the static hint below says it better. */}
      {!isConnected && stage ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-[color:var(--color-foreground)]">
          <StatusDot color={stage.accepted ? "green" : "blue"} pulse />
          {stage.title}
          <span className="font-normal text-[color:var(--color-muted-foreground)]">— {stage.detail}</span>
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
            loading={isPending}
            onClick={() => {
              // Already trying? Show the dialog so the operator can watch for the code, rather
              // than asking them to confirm a second reconnect on top of the one in flight —
              // and, more importantly, rather than restarting an attempt that is mid-flight.
              if (needsScan || account.status === "RECONNECTING") {
                setQrOpen(true);
                return;
              }
              // Otherwise: start, and open the dialog to watch it start.
              //
              // This used to raise "Reconnect this account? Sends a reconnect command to the
              // worker." — a confirmation in front of the one action the page exists for, on an
              // account that is not connected, describing the mechanism rather than the outcome.
              // Nothing here is destructive: it launches a browser. The Reconnect button beside it
              // keeps its confirmation, because on a LIVE session that one really does interrupt
              // something.
              setQrOpen(true);
              startTransition(async () => {
                await onReconnect();
              });
            }}
          >
            <QrCode className="size-3.5" aria-hidden />
            {needsScan
              ? account.pairingMethod === "PHONE_CODE"
                ? "Show link code"
                : "Show QR code"
              : account.status === "RECONNECTING"
                ? "Watch for a code"
                : "Connect"}
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
        <Button variant="secondary" onClick={() => setDialog("advanced")}>
          Advanced
        </Button>
        <Button variant="danger" onClick={() => setDialog("logout")}>
          Logout
        </Button>
        {account.canDelete ? (
          <Button variant="ghost" onClick={openDeleteDialog}>
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

      <AccountAdvancedDialog
        open={dialog === "advanced"}
        onClose={closeDialog}
        accountId={account.id}
        accountLabel={account.label}
        proxyAddress={account.proxyAddress}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onClose={closeDialog}
        onConfirm={confirmDelete}
        loading={isPending}
        title="Delete this WhatsApp account?"
        description={deleteError ?? describeDeletion(deletionImpact)}
        confirmLabel="Delete"
        tone="danger"
      />
    </Card>
  );
}

/**
 * Says what is actually at stake, in the units somebody deciding thinks in.
 *
 * Fourteen relations cascade off a WhatsAppAccount. Listing all fourteen would be noise, so this
 * names the three that cannot be rebuilt — the conversations, the support record, and the AI
 * decision trail — and rolls the rest into a total. A number is only printed when it is non-zero:
 * "0 support activities" reads as reassurance about the wrong thing.
 */
function describeDeletion(impact: AccountHistoryImpact | null): string {
  if (!impact) return "Checking what this account still holds…";
  if (!impact.hasHistory) {
    return "This account holds no messages, groups or support history. Deleting it removes nothing else.";
  }

  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count.toLocaleString()} ${count === 1 ? one : many}`);
  };
  add(impact.messages, "message", "messages");
  add(impact.groups, "group", "groups");
  add(impact.supportActivities, "support activity record", "support activity records");
  add(impact.aiDecisions, "AI decision", "AI decisions");
  add(impact.escalationCases, "escalation case", "escalation cases");

  const listed = parts.join(", ");
  const attendance = impact.attendanceEvidence
    ? " Attendance totals for the days it contributed to will be recalculated."
    : "";
  return `This permanently destroys ${listed}. None of it can be recovered.${attendance} To retire the number without losing its history, use Log out instead.`;
}
