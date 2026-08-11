import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui";
import { requestGroupResync, requestLogout, requestReconnect } from "@/server/actions/accounts";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AccountCard, type AccountCardData } from "./AccountCard";

// A scanned-but-unauthenticated QR is expected to refresh every ~20-30s while
// OpenWA waits for a scan; if it's older than this the refresh stream has
// likely stalled — show a "regenerating" placeholder instead of a dead image.
const QR_STALE_AFTER_MS = 60_000;

function isQrStale(qrUpdatedAtIso: string | null, nowMs: number): boolean {
  if (!qrUpdatedAtIso) return false;
  return nowMs - new Date(qrUpdatedAtIso).getTime() > QR_STALE_AFTER_MS;
}

export default async function AccountsPage() {
  await requireSession();
  const accounts = await prisma.whatsAppAccount.findMany({ orderBy: { createdAt: "asc" } });
  const pendingCommands = await prisma.workerCommand.count({
    where: { status: { in: ["PENDING", "PROCESSING"] } },
  });
  const anyAccountMidConnection = accounts.some((a) => a.status !== "CONNECTED");

  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();
  const accountData: AccountCardData[] = accounts.map((account) => {
    const qrUpdatedAt = account.qrUpdatedAt?.toISOString() ?? null;
    return {
      id: account.id,
      label: account.label,
      phoneNumber: account.phoneNumber,
      status: account.status,
      lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
      lastHeartbeatAt: account.lastHeartbeatAt?.toISOString() ?? null,
      sessionDataPath: account.sessionDataPath,
      qrCode: account.qrCode,
      qrUpdatedAt,
      qrStale: isQrStale(qrUpdatedAt, nowMs),
    };
  });

  return (
    <div>
      <PageHeader
        title="WhatsApp Accounts"
        description="Actions here are relayed to the worker through the database — there is no direct connection between the dashboard and the WhatsApp session."
      />

      {pendingCommands > 0 ? (
        <div className="mb-4">
          <Alert tone="info" title={`${pendingCommands} command(s) waiting for the worker`}>
            The worker polls for new commands roughly every 1.5 seconds.
          </Alert>
        </div>
      ) : null}

      {accountData.length === 0 ? (
        <Card>
          <EmptyState>No account yet. The worker creates one automatically on first startup.</EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          {accountData.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onReconnect={requestReconnect}
              onResync={requestGroupResync}
              onLogout={requestLogout}
            />
          ))}
        </div>
      )}

      {anyAccountMidConnection ? <AutoRefresh /> : null}
    </div>
  );
}
