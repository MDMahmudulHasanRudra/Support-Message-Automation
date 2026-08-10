import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { requestGroupResync, requestReconnect } from "@/server/actions/accounts";

export default async function AccountsPage() {
  await requireSession();
  const accounts = await prisma.whatsAppAccount.findMany({ orderBy: { createdAt: "asc" } });
  const pendingCommands = await prisma.workerCommand.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } });

  return (
    <div>
      <PageHeader
        title="WhatsApp Accounts"
        description="Actions here are relayed to the worker through the database — there is no direct connection between the dashboard and the WhatsApp session."
      />

      {accounts.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No account yet. The worker creates one automatically on first startup.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {accounts.map((account) => (
            <Card key={account.id}>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{account.label}</h2>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{account.phoneNumber ?? "(number not yet known)"}</p>
                </div>
                <Badge color={account.status === "CONNECTED" ? "green" : account.status === "ERROR" ? "red" : "yellow"}>
                  {account.status}
                </Badge>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Last connected</dt>
                  <dd>{account.lastConnectedAt?.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Last heartbeat</dt>
                  <dd>{account.lastHeartbeatAt?.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Session path</dt>
                  <dd className="truncate">{account.sessionDataPath ?? "—"}</dd>
                </div>
              </dl>

              {account.status === "AUTHENTICATION_REQUIRED" && account.qrCode ? (
                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium">Scan this QR code with WhatsApp:</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={account.qrCode} alt="WhatsApp QR code" className="h-56 w-56 rounded-md border border-zinc-200 dark:border-zinc-800" />
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Updated {account.qrUpdatedAt?.toLocaleTimeString() ?? "—"}
                  </p>
                </div>
              ) : null}

              <div className="mt-4 flex gap-2">
                <form action={requestReconnect}>
                  <Button variant="secondary" type="submit">Reconnect</Button>
                </form>
                <form action={requestGroupResync}>
                  <Button variant="secondary" type="submit">Resync Groups</Button>
                </form>
              </div>
            </Card>
          ))}
        </div>
      )}

      {pendingCommands > 0 ? (
        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          {pendingCommands} command(s) waiting for the worker to pick up (polls every ~1.5s).
        </p>
      ) : null}
    </div>
  );
}
