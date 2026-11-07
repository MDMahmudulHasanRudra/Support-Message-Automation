"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { BellRing, X } from "lucide-react";
import { getPushState, savePushDevice } from "@/server/actions/pushDevices";
import { currentSubscription, pushSupported } from "./pushClient";

const DISMISSED = "push-prompt-dismissed";
const SYNCED = "push-device-synced";

/**
 * In the inbox: offers notifications once to somebody who has not decided, and quietly moves a browser that
 * already said yes onto this sign-in, because a device stops receiving alerts when the sign-in it belonged to ends.
 */
export function PushPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void (async () => {
      try {
        // The router is not ready to take a server action until just after the page first paints.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const subscription = await currentSubscription();
        if (subscription) {
          if (Notification.permission === "granted" && !sessionStorage.getItem(SYNCED)) {
            sessionStorage.setItem(SYNCED, "1");
            await savePushDevice(subscription.toJSON());
          }
          return;
        }
        if (Notification.permission !== "default" || localStorage.getItem(DISMISSED)) return;
        const state = await getPushState(null);
        if (!cancelled && state.available) setShow(true);
      } catch {
        // Blocked storage or a browser refusing: the inbox works the same without this.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      // Private mode: it simply asks again next time.
    }
    setShow(false);
  };
  return (
    <div className="fixed bottom-24 left-1/2 z-[var(--z-floating)] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-3 pr-1.5 shadow-[var(--shadow-md)]">
      <BellRing className="size-4 shrink-0 text-[color:var(--color-accent-fg)]" aria-hidden />
      <NextLink href="/account#this-device" className="text-[13px] font-medium hover:underline">
        Get customer alerts on this device
      </NextLink>
      <button type="button" onClick={dismiss} aria-label="Not now" className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
