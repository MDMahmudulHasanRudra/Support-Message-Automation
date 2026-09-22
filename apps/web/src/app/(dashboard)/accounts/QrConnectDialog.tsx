"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Hash, Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { Alert, Button, Dialog, Field, Input, StatusDot } from "@/components/ui";
import { readLinkState, setPairingMethod } from "@/server/actions/accounts";
import { describeConnectionStage, isPairingAccepted } from "@/lib/connectionStage";

export type PairingMethod = "QR_CODE" | "PHONE_CODE";

export interface QrDialogAccount {
  id: string;
  label: string;
  status: string;
  /** The provider's fine-grained lifecycle state — reported, never branched on. */
  connectionStage: string | null;
  phoneNumber: string | null;
  qrCode: string | null;
  qrUpdatedAt: string | null;
  qrStale: boolean;
  pairingMethod: PairingMethod;
  pairingPhoneNumber: string | null;
  /** True when the worker has not checked in recently — every stage below is then frozen, not live. */
  workerOffline?: boolean;
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

/** Matches `QR_STALE_AFTER_MS` in accounts/page.tsx — the same judgement, applied to polled data. */
const QR_STALE_AFTER_MS = 60_000;

/** Matches `WORKER_STALE_AFTER_MS` in accounts/page.tsx, for the same reason. */
const WORKER_STALE_AFTER_MS = 60_000;

/**
 * About once a second. Fast enough that holding a phone up to the screen produces a visible
 * reaction, and affordable because what it reads is one indexed row of seven columns — see
 * `readLinkState` for why this is not simply the page refreshing faster.
 */
const LINK_POLL_MS = 1100;

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
 *
 * While it is open it polls for its own state rather than relying on the page's refresh, because
 * this is the one screen in the app where the delay between something happening and it being shown
 * is the whole experience: a scan that lands is invisible for a page interval, which is long
 * enough to read as a code that did not work.
 */
export function QrConnectDialog({
  open,
  onClose,
  account: serverAccount,
  onReconnect,
  reconnectPending,
}: {
  open: boolean;
  onClose: () => void;
  account: QrDialogAccount;
  onReconnect: () => void;
  reconnectPending: boolean;
}) {
  const account = useLiveLinkState(serverAccount, open);
  const connected = account.status === "CONNECTED";
  const accepted = !connected && isPairingAccepted(account.connectionStage);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={connected ? "Connected" : accepted ? "Accepted" : `Link ${account.label}`}
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
          {/* Hidden once the scan lands. Asking for a new code at that point would abandon the
              attempt that just succeeded, and it is exactly when an impatient hand reaches for it. */}
          {!connected && !accepted ? (
            <Button variant="secondary" onClick={onReconnect} loading={reconnectPending}>
              <RefreshCw className="size-3.5" aria-hidden />
              Request a new code
            </Button>
          ) : null}
        </>
      }
    >
      {connected ? (
        <ConnectedPanel label={account.label} phoneNumber={account.phoneNumber} />
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
          accepted={accepted}
        />
      )}
    </Dialog>
  );
}

/**
 * The account as it is RIGHT NOW, polled while the dialog is open, over the server's snapshot.
 *
 * Two things it is responsible for. The obvious one is latency: the page refreshes every three
 * seconds at best, and three seconds of nothing changing after you scan a code is long enough that
 * people scan again, or press "Request a new code" and cancel the attempt that was about to
 * succeed.
 *
 * The other is keeping the rest of the page honest. Everything outside this dialog — the status
 * badge, the card's hint line, the "commands waiting" banner — is server-rendered, so a dialog that
 * quietly knew better while the card behind it said otherwise would be its own kind of wrong. On
 * every observed status CHANGE it asks Next to re-render the tree, so both react together rather
 * than the dialog leading by a few seconds.
 *
 * Falls back to the server's values whenever it has nothing of its own: before the first poll
 * answers, after a failure, and while closed. A poll that throws is a missed frame, not an error
 * worth putting in front of somebody who is mid-scan.
 */
function useLiveLinkState(serverAccount: QrDialogAccount, open: boolean): QrDialogAccount {
  const router = useRouter();
  const [live, setLive] = useState<Partial<QrDialogAccount> | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Local to this effect run, so no ref is needed and reopening resets it. Starting at null
    // means the first answer always triggers one refresh, which is the right behaviour on open:
    // the page render behind the dialog may already be a few seconds old.
    let lastStatus: string | null = null;

    const tick = async () => {
      try {
        const next = await readLinkState(serverAccount.id);
        if (cancelled) return;
        if (next) {
          setLive({
            status: next.status,
            connectionStage: next.connectionStage,
            phoneNumber: next.phoneNumber,
            qrCode: next.qrCode,
            qrUpdatedAt: next.qrUpdatedAt,
            // Computed here rather than during render: reading the clock while rendering is
            // impure, and this callback already runs on the interval that would drive it anyway.
            qrStale: next.qrUpdatedAt
              ? Date.now() - new Date(next.qrUpdatedAt).getTime() > QR_STALE_AFTER_MS
              : false,
            pairingMethod: next.pairingMethod,
            pairingPhoneNumber: next.pairingPhoneNumber,
            workerOffline:
              !next.lastHeartbeatAt ||
              Date.now() - new Date(next.lastHeartbeatAt).getTime() > WORKER_STALE_AFTER_MS,
          });
          if (next.status !== lastStatus) {
            lastStatus = next.status;
            router.refresh();
          }
        }
      } catch {
        // Deliberately silent. The next tick is 1.1s away and the panel keeps showing the last
        // state it had; surfacing a transient network blip as an error during a scan would be
        // noise about something that fixes itself.
      } finally {
        if (!cancelled) timer = setTimeout(tick, LINK_POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      // Dropping what this subscription produced is part of ending it, and it belongs in the
      // cleanup rather than in an `if (!open)` branch at the top: setting state synchronously in
      // an effect body is the cascading render this project keys around elsewhere. Without it,
      // reopening the dialog would lay the last poll of the previous session over a fresh server
      // render for one round trip — briefly contradicting the page it is sitting on.
      setLive(null);
    };
  }, [open, serverAccount.id, router]);

  return live ? { ...serverAccount, ...live } : serverAccount;
}

/**
 * The end of the job, said plainly.
 *
 * It names the number that actually linked, which is the only thing that distinguishes "it worked"
 * from "it worked, and I linked the wrong phone" — a real risk for a team running several numbers,
 * and one nothing else on this screen would catch.
 */
function ConnectedPanel({ label, phoneNumber }: { label: string; phoneNumber: string | null }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-success-bg)] text-[color:var(--color-success)]">
        <CheckCircle2 className="size-6" aria-hidden />
      </span>
      <p className="text-[15px] font-medium text-[color:var(--color-foreground)]">{label} is linked</p>
      {phoneNumber ? (
        <p className="tabular font-[family-name:var(--font-mono)] text-[13px] text-[color:var(--color-foreground)]">
          +{phoneNumber}
        </p>
      ) : null}
      <p className="max-w-sm text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        Messages will start flowing through immediately. Run a group resync if the group list
        looks out of date.
      </p>
    </div>
  );
}

function PairingPanel({ account, accepted }: { account: QrDialogAccount; accepted: boolean }) {
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
        {accepted
          ? "Nothing more to do on the phone. Leave this open until it says connected."
          : byPhone
            ? "Enter the number this account uses, ask WhatsApp for a code, then type that code into the phone."
            : "Scan this code with the phone that owns this WhatsApp number. It refreshes on its own until it is scanned."}
      </p>

      {/* Above both panels rather than inside one: it governs them both, and a control that lives
          inside the thing it replaces is easy to miss. Hidden once the scan lands, because changing
          method then would throw away the attempt that just succeeded. */}
      {accepted ? null : (
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
      )}

      {byPhone && !accepted ? (
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

      {/* The stage below is written by the worker, so with the worker down it is a snapshot of a
          process that stopped rather than a report on one that is running — and every button in
          here queues work for that same process. The page behind this modal says so already; the
          modal covers it. */}
      {account.workerOffline ? (
        <Alert tone="danger" title="The worker is not responding">
          Nothing below is moving. Whatever it last reported is frozen there, and asking for a new
          code will queue a request nothing is reading until the worker is back.
        </Alert>
      ) : null}

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex flex-col items-center gap-3">
          {accepted ? (
            <AcceptedPanel byPhone={byPhone} />
          ) : byPhone ? (
            <LinkCodePanel
              code={hasUsableCode ? account.qrCode : null}
              stale={account.qrStale}
              awaitingNumber={awaitingNumber}
              phoneNumber={account.pairingPhoneNumber}
            />
          ) : (
            <QrPanel
              code={hasUsableCode ? account.qrCode : null}
              stale={account.qrStale}
              label={account.label}
            />
          )}

          <LiveStageLine
            stage={account.connectionStage}
            awaitingNumber={awaitingNumber}
            codeIssuedAt={hasUsableCode ? account.qrUpdatedAt : null}
            // A stale code is the one case where the stage and the panel disagree: the worker's
            // last word is still QR_AVAILABLE ("the code below is live") while the panel beside it
            // has already replaced that code with "it expired". The panel is right — it is judging
            // the code's age, which the worker does not revisit once written.
            codeExpired={Boolean(account.qrCode) && account.qrStale && codeMatchesView}
          />
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
                  className={`tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    accepted
                      ? "bg-[var(--color-success-bg)] text-[color:var(--color-success)]"
                      : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)]"
                  }`}
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

/**
 * One line saying what is happening right now, under whichever panel is showing.
 *
 * It replaced "Watching for a new code", which was true of the dashboard and said nothing about
 * the session: the same six words sat there through a browser launch, a page load, a live code and
 * an accepted scan. The stage comes from the worker and is rendered through a lookup that answers
 * null for anything it does not recognise, so a state added on the worker side later degrades to
 * the old generic line rather than to a blank.
 */
function LiveStageLine({
  stage,
  awaitingNumber,
  codeIssuedAt,
  codeExpired,
}: {
  stage: string | null;
  awaitingNumber: boolean;
  codeIssuedAt: string | null;
  codeExpired: boolean;
}) {
  const stageCopy = describeConnectionStage(stage);
  // Suppressed rather than overwritten: "the code below is live" is a claim about something that
  // is demonstrably no longer true, and two panels disagreeing about the same code is worse than
  // one of them saying less.
  const copy = codeExpired ? null : stageCopy;
  const accepted = copy?.accepted ?? false;

  // No pulsing dot while nothing has been requested — a live indicator next to an idle form is the
  // same lie the spinner was telling.
  if (awaitingNumber) {
    return (
      <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Nothing requested yet</p>
    );
  }

  return (
    <div className="flex max-w-[20rem] flex-col items-center gap-1 text-center">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-[color:var(--color-foreground)]">
        {accepted ? (
          <CheckCircle2 className="size-3.5 text-[color:var(--color-success)]" aria-hidden />
        ) : (
          <StatusDot color="blue" pulse />
        )}
        {copy ? copy.title : codeExpired ? "That code expired" : "Watching for a new code"}
      </p>
      {copy ? (
        <p className="text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          {copy.detail}
        </p>
      ) : null}
      {/* Kept because it answers a different question from the stage: not "what is happening" but
          "is what I am looking at current". Only shown while a code is genuinely on screen. */}
      {codeIssuedAt && !accepted ? (
        <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
          Code issued at {new Date(codeIssuedAt).toLocaleTimeString()}
        </p>
      ) : null}
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
 * Shown from the instant WhatsApp accepts the pairing until the session is actually usable.
 *
 * It occupies the same space the code did, and that is the point: a code that has been used is
 * spent, and leaving it on screen invites a second scan of something that will not work. The
 * session still has a few seconds of loading to do, so this says so rather than claiming success
 * early — `CONNECTED` is the only thing that closes the dialog.
 */
function AcceptedPanel({ byPhone }: { byPhone: boolean }) {
  return (
    <div className="flex min-h-[292px] w-[292px] flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-success-border,var(--color-border))] bg-[var(--color-success-bg)] p-6 text-center shadow-[var(--shadow-sm)] sm:min-h-[332px] sm:w-[332px]">
      <span className="flex size-12 items-center justify-center rounded-full bg-[var(--color-surface)] text-[color:var(--color-success)]">
        <CheckCircle2 className="size-6" aria-hidden />
      </span>
      <p className="text-[15px] font-medium text-[color:var(--color-foreground)]">
        {byPhone ? "Code accepted" : "Scan accepted"}
      </p>
      <p className="max-w-[17rem] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        WhatsApp has linked this device. Getting the session ready — you can put the phone down.
      </p>
      <Loader2 className="size-4 animate-spin text-[color:var(--color-muted-foreground)]" aria-hidden />
    </div>
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
 * The code as WhatsApp itself presents it: one box per character, with the hyphen left between
 * the halves as a separator rather than as a box of its own.
 *
 * It was a single run of monospaced text. That reads fine on a screen and badly off one — this
 * code is copied by eye, one character at a time, into a phone held in the other hand, and losing
 * your place in an eight-character string is the whole failure mode. Boxes give each character a
 * position to come back to, which is exactly why WhatsApp draws it this way.
 *
 * The whole code stays inside one `select-all` container, so selecting it still yields the plain
 * code with its hyphen and nothing else — boxes are presentation, not a change to what is copied.
 *
 * WhatsApp issues the code with a hyphen in the middle and it is shown exactly as issued: the phone
 * expects what the person sees, so reformatting it would be a small act of sabotage.
 */
function LinkCodeCharacters({ code }: { code: string }) {
  const characters = [...code.trim()];
  return (
    <p
      className="flex select-all flex-wrap items-center justify-center gap-1.5"
      aria-label={`Linking code ${characters.join(" ")}`}
    >
      {characters.map((character, index) =>
        character === "-" ? (
          <span
            key={`sep-${index}`}
            aria-hidden
            className="px-0.5 text-[22px] font-medium text-[color:var(--color-muted-foreground)]"
          >
            –
          </span>
        ) : (
          <span
            key={`char-${index}`}
            className="flex size-[38px] items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] font-[family-name:var(--font-mono)] text-[22px] font-semibold uppercase text-[color:var(--color-foreground)] sm:size-[42px] sm:text-[24px]"
          >
            {character}
          </span>
        ),
      )}
    </p>
  );
}

/**
 * Unlike the QR beside it this keeps the theme's own surface: nothing here is read by a camera, and
 * forcing white would be contrast for its own sake.
 */
function LinkCodePanel({
  code,
  stale,
  awaitingNumber,
  phoneNumber,
}: {
  code: string | null;
  stale: boolean;
  awaitingNumber: boolean;
  /** Which number this code belongs to, echoed back exactly as WhatsApp's own screen does. */
  phoneNumber: string | null;
}) {
  return (
    <div className="flex min-h-[292px] w-[292px] items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 shadow-[var(--shadow-sm)] sm:min-h-[332px] sm:w-[332px]">
      {code ? (
        <div className="text-center">
          <p className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Enter this code
          </p>
          {/* Which number it belongs to, as WhatsApp's own screen states it. A team running several
              numbers has no other way to tell from the code itself, and typing it into the wrong
              phone links the wrong account. */}
          {phoneNumber ? (
            <p className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]">
              for <span className="tabular font-medium text-[color:var(--color-foreground)]">+{phoneNumber}</span>
            </p>
          ) : null}
          <div className="mt-3">
            <LinkCodeCharacters code={code} />
          </div>
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
          ? "That code expired. Press “Request a new code” — it restarts the session, which usually takes under a minute."
          : requestingCode
            ? "Restarting the session to get a fresh code. This usually takes under a minute."
            : "Starting a session and waiting for WhatsApp to issue a code. This usually takes under a minute."}
      </p>
    </div>
  );
}
