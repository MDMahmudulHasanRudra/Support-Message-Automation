"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Alert, Button, Field, Input, SwitchField, Textarea, useToast } from "@/components/ui";
import { saveDomainSettings, type DomainSettingsState } from "@/server/actions/saas";
import type { DomainSettingsData } from "@/server/saasAdmin";

/**
 * The platform's domain settings. Routing is the one switch that changes behaviour, so it says
 * plainly what it does, and the server refuses to turn it on from an address that would then lose
 * the portal.
 */
export function DomainSettingsForm({ canManage, settings, currentHost }: { canManage: boolean; settings: DomainSettingsData; currentHost: string | null }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [state, formAction, pending] = useActionState<DomainSettingsState, FormData>(saveDomainSettings, {});
  const [routing, setRouting] = useState(settings.hostRoutingEnabled);
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: "Domain settings saved", description: "" });
    router.refresh();
  }, [state.savedAt, showToast, router]);

  return (
    <form action={formAction} className="space-y-4">
      <fieldset disabled={!canManage} className="space-y-4">
        <Field label="Root domain" htmlFor="ds-root" error={errors.rootDomain} hint="Customer addresses live under it, e.g. customer2.udboy.com.">
          <Input id="ds-root" name="rootDomain" defaultValue={settings.rootDomain ?? ""} placeholder="udboy.com" className="font-mono" spellCheck={false} />
        </Field>
        <Field
          label="Admin addresses"
          htmlFor="ds-admin"
          error={errors.adminHostnames}
          hint={`One per line. Only these open the Main Admin Portal. While customers move over, keep the address you use today here too${currentHost ? ` (you are on ${currentHost})` : ""}.`}
        >
          <Textarea id="ds-admin" name="adminHostnames" rows={2} defaultValue={settings.adminHostnames.join("\n")} placeholder={"admin.udboy.com"} className="font-mono" spellCheck={false} />
        </Field>
        <Field label="Server public IP" htmlFor="ds-ips" error={errors.publicIps} hint="What every customer address's A record must point to. One per line.">
          <Textarea id="ds-ips" name="publicIps" rows={1} defaultValue={settings.publicIps.join("\n")} placeholder="201.18.218.251" className="font-mono" spellCheck={false} />
        </Field>
        <Field label="Extra reserved names" htmlFor="ds-reserved" error={errors.reservedLabels} hint="Subdomains no customer may take, besides the built-in list (admin, www, api, mail…).">
          <Input id="ds-reserved" name="reservedLabels" defaultValue={settings.reservedLabels.join(", ")} className="font-mono" spellCheck={false} />
        </Field>
        <SwitchField
          name="hostRoutingEnabled"
          checked={routing}
          onChange={(e) => setRouting(e.target.checked)}
          label="Hostname routing"
          description="On: each customer address opens only that customer's workspace, the portal opens only on admin addresses, and an unknown address shows nothing. Off: every address behaves as it always has."
        />
        {errors.hostRoutingEnabled ? <Alert tone="danger">{errors.hostRoutingEnabled}</Alert> : null}
        {routing && !settings.hostRoutingEnabled ? (
          <Alert tone="warning">
            Before saving: make sure the address your current customer uses is added to that customer (Customers) and checked, and that the address you are using now is
            listed as an admin address. Anyone already signed in stays signed in.
          </Alert>
        ) : null}
      </fieldset>
      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" loading={pending}>
            Save settings
          </Button>
        </div>
      ) : null}
      {settings.updatedAt ? (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Last saved {new Date(settings.updatedAt).toLocaleString()}
          {settings.updatedByUsername ? ` by ${settings.updatedByUsername}` : ""}.
        </p>
      ) : null}
    </form>
  );
}
