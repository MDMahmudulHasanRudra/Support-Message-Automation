"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Field, Input } from "@/components/ui";
import { shrinkPicture } from "@/lib/clientPhotoResize";
import {
  cancelMfaSetup,
  changeMyPassword,
  changeMyUsername,
  confirmMfaSetup,
  disableMfa,
  removeMyPhoto,
  replaceRecoveryCodes,
  signOutMyDevice,
  signOutMyOtherDevices,
  startMfaSetup,
  updateMyProfile,
  uploadMyPhoto,
  type AccountFormState,
  type MfaSetupState,
} from "@/server/actions/account";

/**
 * My account's forms (ACCOUNT_SELF_SERVICE.md). Fields are controlled: React resets an action form after
 * every submit, and a refused change must not wipe what the person typed. Passwords are the exception —
 * they are cleared after a successful change, never kept around.
 */

function Result({ state }: { state: AccountFormState }) {
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.success) return <Alert tone="success">{state.success}</Alert>;
  return null;
}

// --- Profile ---------------------------------------------------------------------------------------

export function ProfileForm({ name, email, phone, disabled }: { name: string; email: string | null; phone: string | null; disabled: boolean }) {
  const [state, action, pending] = useActionState(updateMyProfile, {});
  const [values, setValues] = useState({ name, email: email ?? "", phone: phone ?? "" });
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  return (
    <form action={action} className="space-y-4">
      <Field label="Full name" required error={state.fieldErrors?.name}>
        <Input name="name" value={values.name} onChange={set("name")} maxLength={120} autoComplete="name" disabled={disabled} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" hint="Optional. Sign-in is by username." error={state.fieldErrors?.email}>
          <Input name="email" type="email" value={values.email} onChange={set("email")} maxLength={200} autoComplete="email" disabled={disabled} />
        </Field>
        <Field label="Phone" hint="Optional. Shown to colleagues only." error={state.fieldErrors?.phone}>
          <Input name="phone" type="tel" value={values.phone} onChange={set("phone")} maxLength={40} autoComplete="tel" disabled={disabled} />
        </Field>
      </div>
      <Result state={state} />
      <Button type="submit" loading={pending} disabled={disabled}>
        Save profile
      </Button>
    </form>
  );
}

// --- Photo -----------------------------------------------------------------------------------------

export function PhotoForm({ name, avatarUrl, disabled }: { name: string; avatarUrl: string | null; disabled: boolean }) {
  const [state, setState] = useState<AccountFormState>({});
  const [pending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => [...w][0])
      .join("")
      .toUpperCase() || "?";

  const choose = (file: File | undefined) => {
    if (!file) return;
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set("photo", await shrinkPicture(file));
        setState(await uploadMyPhoto(form));
      } catch {
        setState({ error: "That picture could not be read. Choose a JPEG, PNG or WebP photo." });
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <span className="flex size-24 items-center justify-center overflow-hidden rounded-full bg-[var(--color-neutral-bg)] text-2xl font-semibold text-[color:var(--color-muted-foreground)] ring-1 ring-[var(--color-border)]">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- our own authenticated route; next/image would only re-encode a 256 px thumbnail
          <img src={avatarUrl} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden>{initials}</span>
        )}
      </span>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="account-photo" onChange={(e) => choose(e.target.files?.[0])} disabled={disabled || pending} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" loading={pending} disabled={disabled} onClick={() => fileRef.current?.click()}>
          {avatarUrl ? "Change photo" : "Add photo"}
        </Button>
        {avatarUrl ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled || pending} onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-[color:var(--color-muted-foreground)]">JPEG, PNG or WebP. Resized to 256 px; location and camera details are removed.</p>
      <Result state={state} />
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          startTransition(async () => setState(await removeMyPhoto()));
        }}
        title="Remove your photo?"
        description="Colleagues will see your initials instead."
        confirmLabel="Remove photo"
        tone="danger"
      />
    </div>
  );
}

// --- Username --------------------------------------------------------------------------------------

export function UsernameForm({ current, rule, disabled }: { current: string; rule: string; disabled: boolean }) {
  const [username, setUsername] = useState(current);
  const [password, setPassword] = useState("");
  const [state, action, pending] = useActionState(async (prev: AccountFormState, form: FormData) => {
    const result = await changeMyUsername(prev, form);
    if (result.success) setPassword("");
    return result;
  }, {});
  return (
    <form action={action} className="mt-4 space-y-4">
      <Field label="New username" hint={rule} error={state.fieldErrors?.username}>
        <Input name="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} maxLength={40} autoComplete="username" spellCheck={false} disabled={disabled} required />
      </Field>
      <Field label="Current password" error={state.fieldErrors?.currentPassword}>
        <Input name="currentPassword" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={disabled} required />
      </Field>
      <Result state={state} />
      <Button type="submit" loading={pending} disabled={disabled || username.trim() === current}>
        Change username
      </Button>
    </form>
  );
}

// --- Password --------------------------------------------------------------------------------------

export function PasswordForm({ minLength, disabled }: { minLength: number; disabled: boolean }) {
  const [values, setValues] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [state, action, pending] = useActionState(async (prev: AccountFormState, form: FormData) => {
    const result = await changeMyPassword(prev, form);
    if (result.success) setValues({ currentPassword: "", newPassword: "", confirmPassword: "" });
    return result;
  }, {});
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const mismatch = values.confirmPassword.length > 0 && values.confirmPassword !== values.newPassword;
  return (
    <form action={action} className="mt-4 space-y-4">
      <Field label="Current password" error={state.fieldErrors?.currentPassword}>
        <Input name="currentPassword" type="password" value={values.currentPassword} onChange={set("currentPassword")} autoComplete="current-password" disabled={disabled} required />
      </Field>
      <Field label="New password" hint={`At least ${minLength} characters. A short sentence is easier to remember than symbols.`} error={state.fieldErrors?.newPassword}>
        <Input name="newPassword" type="password" value={values.newPassword} onChange={set("newPassword")} autoComplete="new-password" minLength={minLength} disabled={disabled} required />
      </Field>
      <Field label="Confirm new password" error={mismatch ? "The two new passwords do not match." : undefined}>
        <Input name="confirmPassword" type="password" value={values.confirmPassword} onChange={set("confirmPassword")} autoComplete="new-password" disabled={disabled} required />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox name="signOutOthers" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} disabled={disabled} className="mt-0.5" />
        <span>
          Sign out every other device
          <span className="block text-xs text-[color:var(--color-muted-foreground)]">Recommended. This browser stays signed in.</span>
        </span>
      </label>
      <Result state={state} />
      <Button type="submit" loading={pending} disabled={disabled || mismatch}>
        Change password
      </Button>
    </form>
  );
}

// --- Two-step sign-in ------------------------------------------------------------------------------

export function TwoStepPanel({
  enabledAt,
  recoveryCodesLeft,
  setupPending,
  disabled,
}: {
  enabledAt: string | null;
  recoveryCodesLeft: number;
  setupPending: boolean;
  disabled: boolean;
}) {
  const [startState, start, starting] = useActionState(startMfaSetup, {});
  const [confirmState, confirm, confirming] = useActionState(confirmMfaSetup, {});
  const [offState, turnOff, turningOff] = useActionState(disableMfa, {});
  const [codesState, replaceCodes, replacing] = useActionState(replaceRecoveryCodes, {});
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"idle" | "off" | "codes">("idle");
  const [cancelling, startCancel] = useTransition();

  // The secret being set up comes from the latest of the two steps that returned one.
  const setup: MfaSetupState["setup"] = confirmState.setup ?? (confirmState.recoveryCodes ? undefined : startState.setup);
  const shownCodes = confirmState.recoveryCodes ?? codesState.recoveryCodes;

  if (shownCodes) return <RecoveryCodes codes={shownCodes} note={confirmState.success ?? codesState.success ?? ""} />;

  if (!enabledAt && setup) {
    return (
      <div className="space-y-5">
        <ol className="list-decimal space-y-4 pl-5 text-sm">
          <li>
            Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).
          </li>
          <li>
            In the app, add an account and choose <em>Enter a setup key</em>. Use your username as the name, choose <em>Time based</em>, and type this key:
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)] px-3 py-2 font-mono text-[15px] tracking-wider">{setup.secret}</code>
              <CopyButton text={setup.secret.replace(/\s/g, "")} label="Copy key" />
            </div>
            <details className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
              <summary className="cursor-pointer">Setting up on this device instead?</summary>
              <p className="mt-1">
                Some apps open this link directly:{" "}
                <a className="underline" href={setup.uri}>
                  add to authenticator
                </a>
                .
              </p>
            </details>
          </li>
          <li>Enter the 6-digit code the app shows now.</li>
        </ol>
        <form action={confirm} className="flex flex-wrap items-end gap-3">
          <Field label="Code from the app" error={confirmState.fieldErrors?.code}>
            <Input name="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="w-36" disabled={disabled} required />
          </Field>
          <Button type="submit" loading={confirming} disabled={disabled}>
            Turn on two-step sign-in
          </Button>
          <Button
            type="button"
            variant="ghost"
            loading={cancelling}
            onClick={() =>
              startCancel(async () => {
                await cancelMfaSetup();
                window.location.reload();
              })
            }
          >
            Cancel
          </Button>
        </form>
        <Result state={confirmState.fieldErrors ? {} : confirmState} />
      </div>
    );
  }

  if (!enabledAt) {
    return (
      <form action={start} className="space-y-4">
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          {setupPending ? "A setup was started but not finished. Start again to get a new key." : "Off. Your password alone signs you in."}
        </p>
        <Field label="Current password" hint="Needed to start." error={startState.fieldErrors?.currentPassword}>
          <Input name="currentPassword" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="max-w-sm" disabled={disabled} required />
        </Field>
        <Result state={startState} />
        <Button type="submit" loading={starting} disabled={disabled}>
          Set up two-step sign-in
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>On since {enabledAt}.</span>
        <span className="flex items-center gap-1.5">
          Recovery codes left: <Badge color={recoveryCodesLeft <= 2 ? "yellow" : "gray"}>{recoveryCodesLeft}</Badge>
        </span>
      </div>
      {recoveryCodesLeft <= 2 ? <Alert tone="warning">You are running out of recovery codes. Make new ones while you still have your phone.</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setMode(mode === "codes" ? "idle" : "codes")} disabled={disabled} aria-expanded={mode === "codes"}>
          Make new recovery codes
        </Button>
        <Button type="button" variant="ghost" onClick={() => setMode(mode === "off" ? "idle" : "off")} disabled={disabled} aria-expanded={mode === "off"}>
          Turn off
        </Button>
      </div>
      {mode === "codes" ? (
        <form action={replaceCodes} className="flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4">
          <Field label="Current code from your app" hint="Every old recovery code stops working." error={codesState.fieldErrors?.code}>
            <Input name="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="w-40" required />
          </Field>
          <Button type="submit" loading={replacing}>
            Make new codes
          </Button>
          <div className="w-full">
            <Result state={codesState.fieldErrors ? {} : codesState} />
          </div>
        </form>
      ) : null}
      {mode === "off" ? (
        <form action={turnOff} className="space-y-4 border-t border-[var(--color-border)] pt-4">
          <Alert tone="warning">Without two-step sign-in, anyone who learns your password can sign in as you.</Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password" error={offState.fieldErrors?.currentPassword}>
              <Input name="currentPassword" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field label="Code from your app, or a recovery code" error={offState.fieldErrors?.code}>
              <Input name="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={20} required />
            </Field>
          </div>
          <Result state={offState.fieldErrors ? {} : offState} />
          <Button type="submit" variant="danger" loading={turningOff}>
            Turn off two-step sign-in
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function RecoveryCodes({ codes, note }: { codes: string[]; note: string }) {
  const text = codes.join("\n");
  return (
    <div className="space-y-4">
      {note ? <Alert tone="success">{note}</Alert> : null}
      <div>
        <h3 className="text-sm font-semibold">Save your recovery codes now</h3>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Each code signs you in once if you lose your phone. They are shown only this time — store them somewhere safe, away from this computer.
        </p>
      </div>
      <ul className="grid max-w-md grid-cols-2 gap-2 rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} label="Copy codes" />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>
        <Button type="button" onClick={() => window.location.reload()}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}

// --- Devices ---------------------------------------------------------------------------------------

export interface DeviceRow {
  id: string;
  current: boolean;
  device: string;
  ipAddress: string | null;
  signedIn: string;
  lastUsed: string;
  expires: string;
}

export function DevicesPanel({ devices, disabled }: { devices: DeviceRow[]; disabled: boolean }) {
  const [state, setState] = useState<AccountFormState>({});
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const others = devices.filter((d) => !d.current).length;

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)]">
        {devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0 text-sm">
              <p className="flex items-center gap-2 font-medium">
                {d.device}
                {d.current ? <Badge color="green">This device</Badge> : null}
              </p>
              <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                {[d.ipAddress ? `IP ${d.ipAddress}` : null, `signed in ${d.signedIn}`, `last active ${d.lastUsed}`, `expires ${d.expires}`].filter(Boolean).join(" · ")}
              </p>
            </div>
            {d.current ? null : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disabled || pending}
                loading={pending && busyId === d.id}
                onClick={() => {
                  setBusyId(d.id);
                  startTransition(async () => setState(await signOutMyDevice(d.id)));
                }}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <Result state={state} />
          {!state.error && !state.success ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">{others === 0 ? "Only this device is signed in." : `${others} other device${others === 1 ? "" : "s"} signed in.`}</p>
          ) : null}
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={disabled || pending || others === 0} onClick={() => setConfirmAll(true)}>
          Sign out all other devices
        </Button>
      </div>
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          setBusyId(null);
          startTransition(async () => setState(await signOutMyOtherDevices()));
        }}
        title={`Sign out ${others} other device${others === 1 ? "" : "s"}?`}
        description="Every browser except this one will need to sign in again. Anything typed there and not saved is lost."
        confirmLabel="Sign out others"
        tone="danger"
      />
    </div>
  );
}
