"use client";

import type { ReactNode } from "react";

/**
 * A GET filter form that applies itself when a drop-down changes: no Apply press needed, and still an
 * ordinary form, so the URL holds the filters and a view can be bookmarked and shared. The search box
 * applies on Enter (a reload per keystroke would interrupt typing).
 */
export function AutoSubmitForm({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <form
      method="GET"
      className={className}
      onChange={(e) => {
        if ((e.target as HTMLElement).tagName === "SELECT") e.currentTarget.requestSubmit();
      }}
      onSubmit={(e) => {
        // Empty fields stay out of the address, so a shared link reads as the filters actually chosen.
        for (const el of Array.from(e.currentTarget.elements)) {
          const field = el as HTMLInputElement | HTMLSelectElement;
          if (field.name && field.value === "") field.disabled = true;
        }
      }}
    >
      {children}
    </form>
  );
}
