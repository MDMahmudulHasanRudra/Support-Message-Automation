"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls the server component tree via router.refresh() so the QR code and
 * connection status update without a manual page reload. Only rendered
 * while the account is mid-connection (see accounts/page.tsx) — once
 * CONNECTED there is nothing changing worth polling for.
 */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
