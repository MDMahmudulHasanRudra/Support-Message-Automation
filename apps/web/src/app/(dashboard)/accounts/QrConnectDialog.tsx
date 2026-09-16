"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Hash, Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, StatusDot } from "@/components/ui";
import { setPairingMethod } from "@/server/actions/accounts";

export type PairingMethod = "QR_CODE" | "PHONE_CODE";

export interface QrDialogAccount {
  id: string;
  label: string;
  status: string;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  qrStale: boolean;
  pairingMethod: PairingMethod;
  pairingPhoneNumber: string | null;
}

const QR_STEPS = [
  "Open WhatsApp on the phone this account uses.",
  "Tap Menu (⋮) or Settings, then Linked devices.",
  "Tap Link a device.",
  "Point the phone at this screen.",
];

const CODE_STEPS = [
  "Open WhatsApp on the phone this account uses.",
  "Tap Menu (⋮) or Settings, then Linked devices.",
  "Tap Link a device, then Link with phone number instead.",
  "Type the code below into the phone.",
];

/**
 * Linking a WhatsApp account, by either of the two methods WhatsApp itself offers.
 *
 * The QR is a modal rather than an inline 224px image for a plain reason: scanning is a two-device
 * task that owns your attention for thirty seconds, and the dashboard behind it is irrelevant while
 * it is happening. Reading an eight-character code off a screen is the same kind of task.
 *
 * Both methods are official, and `@open-wa/wa-automate` supports both — `ConfigObject.linkCode`
 * selects the second. They are mutually exclusive per attempt rather than a fallback chain, so
 * committing to one starts a fresh connection under it.
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={connected ? "Connected" : `Link ${account.label}`}
      // Deliberately no description here while linking. It used to carry one derived from the
      // SAVED method, which contradicted itself the moment somebody clicked the other tab: the
      // Phone number tab sat under "Scan this code… it refreshes on its own until it is scanned".
      // The line belongs to whichever method is on screen, so the panel that owns that state
      // renders it.
      description={undefined}
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
        /*
         * KEYED, not synchronised by an effect.
         *
         * The panel below seeds two pieces of local state — which method is showing, and the number
         * being typed — from what is stored. Re-seeding those in a `useEffect` is the cascading
         * render the lint rule here exists to catch, and the same mistake `ThreadScroller` in the
         * chat inbox is keyed to avoid. Changing the key remounts the panel, which re-runs the
         * `useState` initialisers, which is what "reset when the stored value changes" actually
         * means in React.
         *
         * `open` is in the key so reopening the dialog discards a half-typed number from last time;
         * the stored values are in it so a successful save is reflected rather than shadowed by the
         * draft that produced it.
         */
        <PairingPanel
          key={`${open}:${account.pairingMethod}:${account.pairingPhoneNumber ?? ""}`}
          account={account}
        />
      )}
    </Dialog>
  );
}

function PairingPanel({ account }: { account: QrDialogAccount }) {
  const [view, setView] = useState<PairingMethod>(account.pairingMethod);
  const [phoneDraft, setPhoneDraft] = useState(account.pairingPhoneNumber ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const byPhone = view === "PHONE_CODE";
  // Only trust the stored code while the view matches the method that produced it. Mid-switch,
  // the previous method's QR would otherwise sit under the phone form for a moment and read as
  // the choice having been ignored.
  const codeMatchesView = view === account.pairingMethod;
  const hasUsableCode = Boolean(account.qrCode) && !account.qrStale && codeMatchesView;

  /**
   * Nothing has been ASKED for yet — the phone tab is showing, but no number has been submitted,
   * so no connection attempt is running and no code is coming.
   *
   * This distinction is the whole reason the dialog looked broken: the panel showed a spinner and
   * "Waiting for the worker to produce a code…" in exactly this state, which says work is under way
   * when none is, and leaves somebody watching a spinner that will never resolve instead of filling
   * in the field six inches above it.
   */
  const awaitingNumber = byPhone && account.pairingMethod !== "PHONE_CODE";

  function commit(method: PairingMethod, phoneNumber?: string) {
    setError(null);
    startTransition(async () => {
      const result = await setPairingMethod(account.id, method, phoneNumber);
      if (result.error) setError(result.error);
    });
  }

  const steps = byPhone ? CODE_STEPS : QR_STEPS;

  return (
    <div className="flex flex-col gap-5">
      {/* Follows the SELECTED tab, not the saved method — see the Dialog above for why it is not a
          `description` prop. */}
      <p className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {byPhone
          ? "Enter the number this account uses, ask WhatsApp for a code, then type that code into the phone."
          : "Scan this code with the phone that owns this WhatsApp number. It refreshes on its own until it is scanned."}
      </p>

      {/* Above both panels rather than inside one: it governs them both, and a control that lives
          inside the thing it replaces is easy to miss. */}
      <div
        role="group"
        aria-label="Linking method"
        className="flex gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-1"
      >
        <MethodTab
          active={!byPhone}
          disabled={pending}
          icon={<QrCode className="size-3.5" aria-hidden />}
          label="QR code"
          onClick={() => {
            setView("QR_CODE");
            // Switching back to QR needs no further input, so it commits immediately — there is
            // nothing to fill in and a second confirming click would be ceremony.
            if (account.pairingMethod !== "QR_CODE") commit("QR_CODE");
          }}
        />
        <MethodTab
          active={byPhone}
          disabled={pending}
          icon={<Hash className="size-3.5" aria-hidden />}
          label="Phone number"
          // Reveals the form without committing. The number is required before this method can do
          // anything, so starting a connection on the tab click would begin an attempt that is
          // guaranteed to fall back to a QR.
          onClick={() => {
            setView("PHONE_CODE");
            setError(null);
          }}
        />
      </div>

      {byPhone ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            commit("PHONE_CODE", phoneDraft);
          }}
        >
          <Field label="Number to link">
            <Input
              value={phoneDraft}
              onChange={(event) => setPhoneDraft(event.target.value)}
              placeholder="8801XXXXXXXXX"
              inputMode="tel"
              autoComplete="tel"
              className="w-56"
              aria-label="Phone number to link, including country code"
            />
          </Field>
          <Button type="submit" variant="secondary" loading={pending}>
            {account.pairingMethod === "PHONE_CODE" ? "Get a new code" : "Get a code"}
          </Button>
        </form>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex flex-col items-center gap-3">
          {byPhone ? (
            <LinkCodePanel
              code={hasUsableCode ? account.qrCode : null}
              stale={account.qrStale}
              awaitingNumber={awaitingNumber}
            />
          ) : (
            <QrPanel
              code={hasUsableCode ? account.qrCode : null}
              stale={account.qrStale}
              label={account.label}
            />
          )}

          <p className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            {/* No pulsing dot while nothing has been requested — a live indicator next to an idle
                form is the same lie the spinner was telling. */}
            {awaitingNumber ? null : <StatusDot color="blue" pulse />}
            {awaitingNumber
              ? "Nothing requested yet"
              : hasUsableCode && account.qrUpdatedAt
                ? `Code issued at ${new Date(account.qrUpdatedAt).toLocaleTimeString()}`
                : "Watching for a new code"}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--color-foreground)]">
            <Smartphone className="size-4 shrink-0" aria-hidden />
            On your phone
          </p>
          <ol className="mt-3 space-y-2.5">
            {steps.map((step, index) => (
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
              {byPhone
                ? // Said plainly because it is the one place the two methods genuinely differ, and
                  // finding out by watching a code go dead is a bad way to learn it.
                  "This dialog closes by itself the moment the link succeeds. Unlike the QR, a link code is issued once and is not refreshed — if it expires, ask for a new one."
                : "This dialog closes by itself the moment the link succeeds — there is nothing to confirm. If the code keeps expiring without connecting, check that the worker is running."}
            </Alert>
          </div>
        </div>
      </div>
    </div>
  );
}

function MethodTab({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-[var(--duration-base)] disabled:opacity-60 ${
        active
          ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]"
          : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The QR always sits on white with real quiet-zone padding, whatever the dashboard theme is. A
 * dark-on-dark code is unscannable, and the failure looks like a broken camera rather than a
 * contrast problem.
 */
function QrPanel({ code, stale, label }: { code: string | null; stale: boolean; label: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-sm)]">
      {code ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data-URI QR from the worker; next/image would only add indirection
        <img
          src={code}
          alt={`WhatsApp linking QR code for ${label}`}
          className="size-[260px] sm:size-[300px]"
        />
      ) : (
        <Waiting stale={stale} onWhite />
      )}
    </div>
  );
}

/**
 * A link code is read off a screen and typed into a phone one character at a time, so it is set
 * large, spaced, and monospaced where 0/O and 1/l cannot be confused. WhatsApp issues it with a
 * hyphen in the middle and it is shown exactly as issued — the phone expects what the person sees,
 * so reformatting it would be a small act of sabotage.
 *
 * Unlike the QR beside it this keeps the theme's own surface: nothing here is read by a camera, and
 * forcing white would be contrast for its own sake.
 */
function LinkCodePanel({
  code,
  stale,
  awaitingNumber,
}: {
  code: string | null;
  stale: boolean;
  awaitingNumber: boolean;
}) {
  return (
    <div className="flex min-h-[292px] w-[292px] items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 shadow-[var(--shadow-sm)] sm:min-h-[332px] sm:w-[332px]">
      {code ? (
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Enter this code
          </p>
          <p className="mt-3 select-all font-[family-name:var(--font-mono)] text-[34px] font-semibold tracking-[0.18em] text-[color:var(--color-foreground)] sm:text-[40px]">
            {code}
          </p>
          <p className="mt-3 text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Type it into Linked devices on the phone that owns this number.
          </p>
        </div>
      ) : awaitingNumber ? (
        <div className="flex size-[260px] flex-col items-center justify-center gap-3 px-2 text-center sm:size-[300px]">
          <Hash className="size-6 text-[color:var(--color-muted-foreground)]" aria-hidden />
          <p className="text-[13px] font-medium text-[color:var(--color-foreground)]">
            Enter the number above
          </p>
          <p className="max-w-[17rem] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Type the full number this account uses, including its country code, then press{" "}
            <span className="font-medium text-[color:var(--color-foreground)]">Get a code</span>.
            WhatsApp issues the code to that number.
          </p>
        </div>
      ) : (
        <Waiting stale={stale} requestingCode />
      )}
    </div>
  );
}

/**
 * `onWhite` because the QR's panel is forced white in both themes; a token colour vanishes on it.
 *
 * `requestingCode` sets the expectation that this takes a while. Asking for a link code restarts
 * the session — a fresh Chromium, WhatsApp Web loaded again — so the gap between pressing the
 * button and seeing a code is tens of seconds, not the instant refresh the QR path conditions
 * people to expect. Unexplained, that reads as broken at about the twenty-second mark.
 */
function Waiting({
  stale,
  onWhite = false,
  requestingCode = false,
}: {
  stale: boolean;
  onWhite?: boolean;
  requestingCode?: boolean;
}) {
  return (
    <div className="flex size-[260px] flex-col items-center justify-center gap-3 px-2 text-center sm:size-[300px]">
      <Loader2
        className={`size-6 animate-spin ${onWhite ? "text-[color:#71717a]" : "text-[color:var(--color-muted-foreground)]"}`}
        aria-hidden
      />
      <p
        className={`max-w-[17rem] text-[13px] leading-relaxed ${onWhite ? "text-[color:#52525b]" : "text-[color:var(--color-muted-foreground)]"}`}
      >
        {stale
          ? "That code expired. Waiting for the worker to produce a fresh one…"
          : requestingCode
            ? "Asking WhatsApp for a code. This restarts the session, so it usually takes under a minute."
            : "Waiting for the worker to produce a code…"}
      </p>
    </div>
  );
}
