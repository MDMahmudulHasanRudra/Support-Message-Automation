/**
 * A URL parameter narrowed to one member of a Prisma enum, or null.
 *
 * Every list filter in this app reads its values from the query string, and the query string is
 * whatever somebody pasted, bookmarked or hand-edited. A value cast straight to an enum
 * (`params.status as NotificationStatus`) reaches Prisma unchecked, and Prisma answers an unknown
 * member by THROWING a validation error — which Next renders as the whole page replaced by the
 * error boundary. That shipped on System Logs, Broadcast History, Messages and Notifications.
 *
 * Checked against Prisma's own runtime enum object rather than a list copied into each page, so a
 * status added to the schema is accepted the moment it exists instead of being silently
 * unfilterable until somebody remembers the copy.
 *
 *     const status = enumParam(NotificationStatus, filters.status);
 *     if (status) where.status = status;
 */
export function enumParam<T extends string>(values: Record<string, T>, raw: string | undefined | null): T | null {
  if (!raw) return null;
  return (Object.values(values) as string[]).includes(raw) ? (raw as T) : null;
}
