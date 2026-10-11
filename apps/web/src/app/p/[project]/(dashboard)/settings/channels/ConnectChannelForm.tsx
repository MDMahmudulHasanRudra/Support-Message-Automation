"use client";

import { useActionState, useEffect } from "react";
import type { ChannelType } from "@support-automation/shared";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input } from "@/components/ui";
import { connectChannelAction, updateChannelCredentialsAction, type ChannelActionResult } from "@/server/actions/channelConnections";

/**
 * The credential form, for connecting (no `connectionId`) or for replacing a connection's credentials.
 * Secret fields are password inputs with autocomplete off; nothing typed here is ever sent back to the
 * browser by the server.
 */
export function ConnectChannelForm({ type, connectionId }: { type: ChannelType; connectionId?: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ChannelActionResult, FormData>(connectionId ? updateChannelCredentialsAction : connectChannelAction, {});

  useEffect(() => {
    if (state.connectionId && !connectionId) router.push(`/settings/channels/${state.connectionId}${state.warning ? "?warning=1" : "?connected=1"}`);
  }, [state.connectionId, state.warning, connectionId, router]);

  return (
    <form action={formAction} className="space-y-4" autoComplete="off">
      <input type="hidden" name="type" value={type} />
      {connectionId ? <input type="hidden" name="connectionId" value={connectionId} /> : null}
      {type === "TELEGRAM" ? (
        <Field
          label="Bot token"
          htmlFor="botToken"
          required={!connectionId}
          hint={connectionId ? "Leave empty to register the webhook again with the saved token. Paste a new token after /revoke in BotFather." : "From BotFather: digits, a colon and a long code."}
        >
          <Input id="botToken" name="botToken" type="password" autoComplete="off" spellCheck={false} placeholder="123456789:AA…" />
        </Field>
      ) : (
        <>
          <Field label="App ID" htmlFor="appId" required hint="App settings → Basic, at the top.">
            <Input id="appId" name="appId" inputMode="numeric" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="App Secret" htmlFor="appSecret" required hint="App settings → Basic → App secret → Show. Signs every webhook Meta sends.">
            <Input id="appSecret" name="appSecret" type="password" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Page access token" htmlFor="pageAccessToken" required hint={type === "INSTAGRAM" ? "For the Facebook Page the Instagram account is linked to." : "For the Page — not your personal profile."}>
            <Input id="pageAccessToken" name="pageAccessToken" type="password" autoComplete="off" spellCheck={false} />
          </Field>
        </>
      )}
      {state.error ? <Alert tone="danger" title={state.error} /> : null}
      {state.warning && connectionId ? <Alert tone="warning" title={state.warning} /> : null}
      {state.success && connectionId ? <Alert tone="success" title={state.success} /> : null}
      <Button type="submit" loading={pending}>
        {connectionId ? (type === "TELEGRAM" ? "Save and register webhook" : "Check and save") : "Check and connect"}
      </Button>
    </form>
  );
}
