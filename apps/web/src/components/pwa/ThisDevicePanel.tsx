"use client";

import { useEffect, useState, useTransition } from "react";
import { BellRing, Download, Share, Smartphone } from "lucide-react";
import { Alert, Button, Card, Switch } from "@/components/ui";
import { getPushState, removePushDevice, savePushDevice, sendTestPush, updatePushPrefs } from "@/server/actions/pushDevices";
import type { PushPrefs } from "@/lib/pushRules";
import { currentSubscription, isInstalledApp, isIos, pushSupported, subscribeThisBrowser } from "./pushClient";

const CHOICES: Array<{ key: keyof PushPrefs; label: string; hint: string }> = [
  { key: "notifyAssigned", label: "A conversation is assigned to me", hint: "By a colleague or by automatic routing." },
  { key: "notifyCustomerMessages", label: "A customer writes in my conversation", hint: "At most once every five minutes per conversation." },
  { key: "notifyMentions", label: "Somebody mentions me in a note", hint: "Internal notes only." },
  { key: "notifyWaiting", label: "A customer is waiting with nobody assigned", hint: "At most once a minute, as a count when several are waiting." },
  { key: "showPreview", label: "Show message text", hint: "Off keeps customers' words off your lock screen." },
];

/** My account: install the app, and notifications for this browser or phone (AGENT_APP.md). */
export function ThisDevicePanel({ disabled }: { disabled: boolean }) {
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [available, setAvailable] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    const offer = () => setCanInstall(Boolean(window.__installPrompt));
    offer();
    window.addEventListener("installpromptready", offer);
    void (async () => {
      // The router is not ready to take a server action until just after the page first paints.
      await new Promise((resolve) => setTimeout(resolve, 400));
      setInstalled(isInstalledApp());
      setIos(isIos());
      const can = pushSupported();
      setSupported(can);
      if (can) setPermission(Notification.permission);
      let current: string | null = null;
      try {
        current = (await currentSubscription())?.endpoint ?? null;
      } catch {
        current = null;
      }
      setEndpoint(current);
      const state = await getPushState(current);
      setAvailable(state.available);
      setPublicKey(state.publicKey);
      setPrefs(state.prefs);
      setReady(true);
    })();
    return () => window.removeEventListener("installpromptready", offer);
  }, []);

  const install = async () => {
    const prompt = window.__installPrompt;
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    window.__installPrompt = null;
    setCanInstall(false);
    if (choice.outcome === "accepted") setInstalled(true);
  };

  const turnOn = () =>
    start(async () => {
      setMessage(null);
      try {
        const answer = await Notification.requestPermission();
        setPermission(answer);
        if (answer !== "granted" || !publicKey) return;
        const subscription = await subscribeThisBrowser(publicKey);
        const saved = await savePushDevice(subscription.toJSON());
        if (saved.error) {
          await subscription.unsubscribe().catch(() => {});
          setMessage({ tone: "danger", text: saved.error });
          return;
        }
        setEndpoint(subscription.endpoint);
        setPrefs(saved.prefs ?? null);
        setMessage({ tone: "success", text: "Notifications are on for this device." });
      } catch {
        setMessage({ tone: "danger", text: "This browser could not turn notifications on. Check your connection and its notification settings, then try again." });
      }
    });

  const turnOff = () =>
    start(async () => {
      setMessage(null);
      const subscription = await currentSubscription().catch(() => null);
      await subscription?.unsubscribe().catch(() => {});
      if (endpoint) await removePushDevice(endpoint);
      setEndpoint(null);
      setPrefs(null);
      setMessage({ tone: "success", text: "Notifications are off for this device." });
    });

  const change = (key: keyof PushPrefs, value: boolean) => {
    if (!endpoint || !prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: value });
    start(async () => {
      const result = await updatePushPrefs(endpoint, { [key]: value });
      if (result.error) {
        setPrefs(before);
        setMessage({ tone: "danger", text: result.error });
      }
    });
  };

  const test = () =>
    start(async () => {
      setMessage(null);
      if (!endpoint) return;
      const result = await sendTestPush(endpoint);
      setMessage(result.error ? { tone: "danger", text: result.error } : { tone: "success", text: "Test sent. It should arrive in a few seconds." });
    });

  const on = Boolean(endpoint && prefs);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Smartphone className="size-4 text-[color:var(--color-accent-fg)]" aria-hidden />
          Install the app
        </h3>
        {installed ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">You are using the installed app on this device.</p>
        ) : canInstall ? (
          <>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Open the inbox from your home screen, full screen, like any other app.</p>
            <Button className="mt-3" onClick={() => void install()}>
              <Download className="size-4" aria-hidden />
              Install app
            </Button>
          </>
        ) : ios ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            In Safari, tap <Share className="inline size-3.5 align-text-bottom" aria-label="Share" /> Share, then <strong>Add to Home Screen</strong>. Open the app from there to turn on notifications.
          </p>
        ) : (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Open your browser&apos;s menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>. If neither is listed, it is already installed or this browser does not offer it.
          </p>
        )}
      </Card>

      <Card>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <BellRing className="size-4 text-[color:var(--color-accent-fg)]" aria-hidden />
          Notifications on this device
        </h3>
        {message ? (
          <div className="mt-3">
            <Alert tone={message.tone}>{message.text}</Alert>
          </div>
        ) : null}
        {!ready ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Checking this device…</p>
        ) : disabled ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Not available in a support session.</p>
        ) : !available ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Notifications are not switched on for this installation yet. Ask whoever runs your Get Assist platform.</p>
        ) : !supported ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">{ios ? "On iPhone, install the app first, then open it from your home screen and come back here." : "This browser does not support notifications."}</p>
        ) : permission === "denied" ? (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">This browser has blocked notifications for this site. Allow them in the browser&apos;s site settings, then reload this page.</p>
        ) : !on ? (
          <>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">Get an alert when a customer needs you, even with this app closed. Ends when you sign out here.</p>
            <Button className="mt-3" onClick={turnOn} loading={busy}>
              Turn on notifications
            </Button>
          </>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-[var(--color-border)]">
              {CHOICES.map((choice) => (
                <li key={choice.key} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{choice.label}</span>
                    <span className="block text-xs text-[color:var(--color-muted-foreground)]">{choice.hint}</span>
                  </span>
                  <Switch checked={Boolean(prefs?.[choice.key])} onChange={(event) => change(choice.key, event.target.checked)} aria-label={choice.label} />
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={test} disabled={busy}>
                Send a test
              </Button>
              <Button variant="ghost" size="sm" onClick={turnOff} disabled={busy}>
                Turn off
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
