"use client";

import { useEffect } from "react";
import { PALETTE_COOKIE } from "@/lib/themes";

/**
 * Keeps this browser's sign-in page in the colours its person works in (owner, 14 Nov 2026): while somebody
 * is signed in, the theme they see (their own choice, or the installation default when they made none) is
 * written to the `sa-palette` cookie, which is what the signed-out sign-in page reads. Changing the theme on
 * My Account, or a Main Admin changing the default, reaches the sign-in page on the next page they open.
 * A colour name only: it grants nothing and is checked against the catalogue wherever it is read.
 */
export function PaletteCookieSync({ palette }: { palette: string }) {
  useEffect(() => {
    try {
      const current = document.cookie
        .split("; ")
        .find((part) => part.startsWith(`${PALETTE_COOKIE}=`))
        ?.slice(PALETTE_COOKIE.length + 1);
      if (current === palette) return;
      const secure = window.location.protocol === "https:" ? "; secure" : "";
      document.cookie = `${PALETTE_COOKIE}=${encodeURIComponent(palette)}; path=/; max-age=31536000; samesite=lax${secure}`;
    } catch {
      // Blocked cookies only mean the sign-in page keeps the installation default.
    }
  }, [palette]);
  return null;
}
