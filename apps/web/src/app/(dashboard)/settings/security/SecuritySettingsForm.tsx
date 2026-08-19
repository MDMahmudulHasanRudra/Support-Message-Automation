"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  Field,
  Input,
  SectionHeader,
  useToast,
} from "@/components/ui";
import { updateSecuritySettings, type SecuritySettingsFormState } from "@/server/actions/securitySettings";
import { revokeAllSessionsExceptMine, revokeAllSessionsGlobally } from "@/server/actions/sessions";
import type { SecuritySettings } from "@prisma/client";

const CONFIRM_PHRASE = "REVOKE ALL SESSIONS";

export function SecuritySettingsForm({ settings }: { settings: SecuritySettings }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<SecuritySettingsFormState, FormData>(updateSecuritySettings, {});
  const { showToast } = useToast();

  const [dangerOpen, setDangerOpen] = useState(false);
  const [includeCaller, setIncludeCaller] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isRevoking, startRevoke] = useTransition();
  const [revokeResult, setRevokeResult] = useState<{ error?: string } | null>(null);

  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: "Security settings saved" });
    } else if (state.error) {
      showToast({ tone: "danger", title: "Could not save settings", description: state.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  function openDanger(includeSelf: boolean) {
    setIncludeCaller(includeSelf);
    setConfirmText("");
    setRevokeResult(null);
    setDangerOpen(true);
  }

  function confirmRevokeAll() {
    startRevoke(async () => {
      const result = includeCaller ? await revokeAllSessionsGlobally() : await revokeAllSessionsExceptMine();
      setRevokeResult(result);
      if (!result.error) {
        router.refresh();
        if (includeCaller) {
          // The caller's own session is now revoked too — the next server request (including
          // this router.refresh()) will already redirect to /login via requireSession().
          return;
        }
        setDangerOpen(false);
      }
    });
  }

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4">
        <Card>
          <SectionHeader title="Session Lifetime" />
          <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
            Controls how long a new login session remains valid. Changing this only affects
            sessions created after you save — sessions already issued keep their original expiry.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Session Lifetime (hours)" hint="Between 1 and 720 (30 days).">
              <Input name="sessionLifetimeHours" type="number" min={1} max={720} defaultValue={settings.sessionLifetimeHours} />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHeader title="Login Lockout" />
          <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
            Temporarily blocks login after too many wrong passwords in a row.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Failed Attempts Before Lockout">
              <Input name="loginLockoutThreshold" type="number" min={1} defaultValue={settings.loginLockoutThreshold} />
            </Field>
            <Field label="Attempt Window (minutes)">
              <Input name="loginLockoutWindowMinutes" type="number" min={1} defaultValue={settings.loginLockoutWindowMinutes} />
            </Field>
            <Field label="Lockout Duration (minutes)">
              <Input name="loginLockoutDurationMinutes" type="number" min={1} defaultValue={settings.loginLockoutDurationMinutes} />
            </Field>
          </div>
        </Card>

        <Button type="submit" loading={pending}>
          Save
        </Button>
      </form>

      <Card className="border-[var(--color-danger-border)]">
        <SectionHeader title="Danger Zone" />
        <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
          Force-logout every App User from every device. Each session becomes invalid immediately
          — it does not wait for its natural expiry.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => openDanger(false)}>
            Revoke All Sessions Except Mine
          </Button>
          <Button variant="danger" onClick={() => openDanger(true)}>
            Revoke Every Session, Including Mine
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={dangerOpen}
        onClose={() => setDangerOpen(false)}
        onConfirm={confirmRevokeAll}
        loading={isRevoking}
        confirmDisabled={confirmText !== CONFIRM_PHRASE}
        tone="danger"
        title={includeCaller ? "Sign out every App User, including yourself?" : "Sign out every App User except yourself?"}
        description={
          includeCaller
            ? "You are about to sign out every App User from every device, including this one. You will be redirected to the login page."
            : "You are about to sign out every App User from every device except this one."
        }
        confirmLabel="Revoke Sessions"
      >
        <div className="space-y-2">
          {revokeResult?.error ? <Alert tone="danger">{revokeResult.error}</Alert> : null}
          <Field label={`Type "${CONFIRM_PHRASE}" to confirm`}>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}
