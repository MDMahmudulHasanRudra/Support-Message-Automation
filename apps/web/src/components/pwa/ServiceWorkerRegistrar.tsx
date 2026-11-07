"use client";

import { useEffect } from "react";

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __installPrompt?: InstallPromptEvent | null;
  }
}

/** Registers the service worker and keeps the browser's install offer, which fires only once and often before anything asks for it. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    const keep = (event: Event) => {
      event.preventDefault();
      window.__installPrompt = event as InstallPromptEvent;
      window.dispatchEvent(new Event("installpromptready"));
    };
    window.addEventListener("beforeinstallprompt", keep);
    return () => window.removeEventListener("beforeinstallprompt", keep);
  }, []);
  return null;
}
