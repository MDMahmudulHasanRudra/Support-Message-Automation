"use client";

import { CheckCircle2, Loader2, RefreshCw, Smartphone } from "lucide-react";
import { Alert, Button, Dialog, StatusDot } from "@/components/ui";

export interface QrDialogAccount {
  label: string;
  status: string;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  qrStale: boolean;
}

const STEPS = [
  "Open WhatsApp on the phone this account uses.",
  "Tap Menu (⋮) or Settings, then Linked devices.",
  "Tap Link a device.",
  "Point the phone at this screen.",
];

/**
 * Linking a WhatsApp account, at a size someone can actually scan.
 *
 * The QR previously sat inline in the account card at 224px, which is small enough that people
 * lean in or lift the laptop. It is a modal now for a plain reason: scanning is a two-device task
 * that owns your attention for thirty seconds, and the dashboard behind it is irrelevant while it
 * is happening.
 */
export function QrConnectDialog({
  open,
  onClose,
  account,
  onReconnect,
  reconnectPending,
}: {
  open: boolean;
  onClose: () => void;
  account: QrDialogAccount;
  onReconnect: () => void;
  reconnectPending: boolean;
}) {
  const connected = account.status === "CONNECTED";
  const hasUsableQr = Boolean(account.qrCode) && !account.qrStale && !connected;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={connected ? "Connected" : `Link ${account.label}`}
      description={
        connected
          ? undefined
          : "Scan this code with the phone that owns this WhatsApp number. It refreshes on its own until it is scanned."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {connected ? "Done" : "Close"}
          </Button>
          {!connected ? (
            <Button variant="secondary" onClick={onReconnect} loading={reconnectPending}>
              <RefreshCw className="size-3.5" aria-hidden />
              Request a new code
            </Button>
          ) : null}
        </>
      }
    >
      {connected ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-success-bg)] text-[color:var(--color-success)]">
            <CheckCircle2 className="size-6" aria-hidden />
          </span>
          <p className="text-[15px] font-medium text-[color:var(--color-foreground)]">
            {account.label} is linked
          </p>
          <p className="max-w-sm text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Messages will start flowing through immediately. Run a group resync if the group list
            looks out of date.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-3">
            {/* The QR always sits on white with real quiet-zone padding, whatever the dashboard
                theme is. A dark-on-dark code is unscannable, and the failure looks like a broken
                camera rather than a contrast problem. */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-sm)]">
              {hasUsableQr ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data-URI QR from the worker; next/image would only add indirection
                <img
                  src={account.qrCode!}
                  alt={`WhatsApp linking QR code for ${account.label}`}
                  className="size-[260px] sm:size-[300px]"
                />
              ) : (
                <div className="flex size-[260px] flex-col items-center justify-center gap-3 text-center sm:size-[300px]">
                  <Loader2 className="size-6 animate-spin text-[color:#71717a]" aria-hidden />
                  <p className="max-w-[16rem] text-[13px] leading-relaxed text-[color:#52525b]">
                    {account.qrStale
                      ? "That code expired. Waiting for the worker to produce a fresh one…"
                      : "Waiting for the worker to produce a code…"}
                  </p>
                </div>
              )}
            </div>

            <p className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              <StatusDot color="blue" pulse />
              {hasUsableQr && account.qrUpdatedAt
                ? `Code refreshed at ${new Date(account.qrUpdatedAt).toLocaleTimeString()}`
                : "Watching for a new code"}
            </p>
          </div>

          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--color-foreground)]">
              <Smartphone className="size-4 shrink-0" aria-hidden />
              On your phone
            </p>
            <ol className="mt-3 space-y-2.5">
              {STEPS.map((step, index) => (
                <li key={step} className="flex gap-2.5 text-[13px] leading-relaxed">
                  <span
                    aria-hidden
                    className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-neutral-bg)] text-[11px] font-semibold text-[color:var(--color-neutral-fg)]"
                  >
                    {index + 1}
                  </span>
                  <span className="text-[color:var(--color-muted-foreground)]">{step}</span>
                </li>
              ))}
            </ol>

            <div className="mt-5">
              <Alert tone="info">
                This dialog closes by itself the moment the link succeeds — there is nothing to
                confirm. If the code keeps expiring without connecting, check that the worker is
                running.
              </Alert>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
