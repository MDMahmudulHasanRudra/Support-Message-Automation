import { Eye } from "lucide-react";

/**
 * Says, once and at the top, that this page is readable but not changeable for this user.
 *
 * Every action on a module checks the module's manage permission, so a view-only user pressing a
 * button is refused — either with the message in the form, or by being sent to the Overview with a
 * banner. Finding that out one refused click at a time is a poor way to learn your role's limits, so
 * a page tells them up front. Rendered by a page only when `pageAccess()` reports `canManage: false`.
 */
export function ViewOnlyNotice() {
  return (
    <div
      role="note"
      className="mb-5 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[13px] text-[color:var(--color-muted-foreground)]"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-[color:var(--color-foreground)]">View only.</span> Your role can see this
        page but not change anything on it.
      </span>
    </div>
  );
}
