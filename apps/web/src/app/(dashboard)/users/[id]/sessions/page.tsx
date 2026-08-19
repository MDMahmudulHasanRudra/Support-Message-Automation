import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { requirePermission } from "@/server/permissions";
import { getCurrentSessionId } from "@/server/actions/sessions";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { SessionsTable, type SessionRow } from "./SessionsTable";

/** Display-only device label derived from the User-Agent header — never used as a security identity. */
function deviceLabelFromUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  let browser = "Unknown browser";
  if (userAgent.includes("Edg/")) browser = "Edge";
  else if (userAgent.includes("Chrome/")) browser = "Chrome";
  else if (userAgent.includes("Firefox/")) browser = "Firefox";
  else if (userAgent.includes("Safari/") && !userAgent.includes("Chrome/")) browser = "Safari";

  let os = "Unknown OS";
  if (userAgent.includes("Windows")) os = "Windows";
  else if (userAgent.includes("Android")) os = "Android";
  else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) os = "iOS";
  else if (userAgent.includes("Mac OS")) os = "macOS";
  else if (userAgent.includes("Linux")) os = "Linux";

  return `${browser} on ${os}`;
}

export default async function UserSessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  await requirePermission(session, "users.sessions");

  const { id } = await params;
  const [user, sessions, currentSessionId] = await Promise.all([
    prisma.user.findUnique({ where: { id }, select: { id: true, username: true } }),
    prisma.userSession.findMany({ where: { userId: id }, orderBy: { lastUsedAt: "desc" } }),
    getCurrentSessionId(),
  ]);
  if (!user) notFound();

  const now = new Date();
  const rows: SessionRow[] = sessions.map((s) => ({
    id: s.id,
    deviceLabel: deviceLabelFromUserAgent(s.userAgent),
    ipAddress: s.ipAddress,
    lastActiveLabel: formatDateTime(s.lastUsedAt),
    status: s.revokedAt ? "REVOKED" : s.expiresAt <= now ? "EXPIRED" : "ACTIVE",
    isCurrentDevice: s.id === currentSessionId,
  }));

  return (
    <div>
      <PageHeader
        title={`Sessions: ${user.username}`}
        description="Every device this user has logged in from."
        actions={
          <HelpButton moduleTitle="Sessions">
            <HelpSection title="What this is">
              <p>
                One row per login. A user can be signed in on several devices at once — logging
                out of one does not affect the others. Revoking a session takes effect
                immediately: that device is rejected on its very next request, it does not wait
                for the session's natural expiry.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <SessionsTable userId={user.id} sessions={rows} />
    </div>
  );
}
