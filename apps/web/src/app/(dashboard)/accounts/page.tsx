/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Alert, Card, EmptyState, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import {
  deleteWhatsAppAccount,
  removePrimaryAccount,
  requestGroupResync,
  requestLogout,
  requestReconnect,
  setPrimaryAccount,
} from "@/server/actions/accounts";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AccountCard, type AccountCardData } from "./AccountCard";
import { AddAccountDialog } from "./AddAccountDialog";

// A scanned-but-unauthenticated QR is expected to refresh every ~20-30s while
// OpenWA waits for a scan; if it's older than this the refresh stream has
// likely stalled — show a "regenerating" placeholder instead of a dead image.
const QR_STALE_AFTER_MS = 60_000;

// Keep in sync with the WhatsAppServiceKey enum in schema.prisma — used only to
// render a human-readable "explicitly used by" label per account.
const SERVICE_LABELS: Record<string, string> = {
  NOTIFY_WHATSAPP: "Support Notifications",
  PRIORITY_SUPPORT: "Escalations",
};

function isQrStale(qrUpdatedAtIso: string | null, nowMs: number): boolean {
  if (!qrUpdatedAtIso) return false;
  return nowMs - new Date(qrUpdatedAtIso).getTime() > QR_STALE_AFTER_MS;
}

export default async function AccountsPage() {
  await requireSession();
  // Three independent reads, so one round trip rather than three sequential ones.
  const [accounts, pendingCommands, routes] = await Promise.all([
    prisma.whatsAppAccount.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.workerCommand.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.whatsAppServiceRoute.findMany({ where: { enabled: true, accountId: { not: null } } }),
  ]);

  const usedByAccountId = new Map<string, string[]>();
  for (const route of routes) {
    if (!route.accountId) continue;
    const label = SERVICE_LABELS[route.serviceKey] ?? route.serviceKey;
    const list = usedByAccountId.get(route.accountId) ?? [];
    list.push(label);
    usedByAccountId.set(route.accountId, list);
  }

  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();

  /**
   * Poll only while something is genuinely in flight.
   *
   * This used to refresh whenever any account was not CONNECTED, which meant a permanently
   * disconnected account — the normal resting state of a spare number nobody is linking — kept
   * the page re-querying every four seconds forever, for a value that cannot change on its own.
   * A DISCONNECTED account only moves when the worker is asked to move it, and that ask is a
   * WorkerCommand, so pending work is the honest signal.
   */
  const isSettling = accounts.some(
    (account) => account.status === "AUTHENTICATION_REQUIRED" || account.status === "RECONNECTING",
  );
  const shouldPoll = isSettling || pendingCommands > 0;

  /**
   * Whether the worker is alive at all.
   *
   * Every button on this page writes a WorkerCommand row and waits for the worker to act on it.
   * With the worker down they all still "succeed" — the row is written, the toast says the
   * request went in — and then nothing happens, with no way to tell that from a slow reconnect.
   * The heartbeat is the one signal that separates the two, so it is worth stating plainly
   * rather than leaving as a timestamp to interpret.
   */
  const WORKER_STALE_AFTER_MS = 60_000;
  const lastHeartbeatMs = accounts.reduce<number | null>((newest, account) => {
    const at = account.lastHeartbeatAt?.getTime() ?? null;
    if (at === null) return newest;
    return newest === null || at > newest ? at : newest;
  }, null);
  const workerOffline = lastHeartbeatMs === null || nowMs - lastHeartbeatMs > WORKER_STALE_AFTER_MS;
  const workerSilentForMinutes =
    lastHeartbeatMs === null ? null : Math.floor((nowMs - lastHeartbeatMs) / 60_000);
  const accountData: AccountCardData[] = accounts.map((account) => {
    const qrUpdatedAt = account.qrUpdatedAt?.toISOString() ?? null;
    return {
      id: account.id,
      label: account.label,
      phoneNumber: account.phoneNumber,
      status: account.status,
      isPrimary: account.isPrimary,
      usedByServices: usedByAccountId.get(account.id) ?? [],
      canDelete: accounts.length > 1 && !account.isPrimary,
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
        actions={
          <>
            <HelpButton moduleTitle="WhatsApp Accounts">
              <HelpSection title="What this page is for">
                <p>
                  Connect and manage the WhatsApp account(s) this system automates. Every action here
                  (reconnect, resync groups, logout) is queued as a command for the worker to pick up —
                  the dashboard never talks to WhatsApp directly, so nothing here happens instantly; give
                  it a few seconds.
                </p>
              </HelpSection>
              <HelpSection title="Adding an account">
                <p>
                  Click "Add Account" and give it a label. The worker notices the new account within ~20
                  seconds and generates a fresh QR code for you to scan — no need to refresh manually,
                  it appears automatically once ready.
                </p>
              </HelpSection>
              <HelpSection title="Primary account">
                <p>
                  Exactly one account can be Primary at a time — it's the default account used by every
                  feature (Support Notifications, Priority Support, etc.) that hasn't been explicitly
                  routed to a specific account on the Account Routing page. The very first account is
                  made Primary automatically; you never have to set one manually unless you add more
                  accounts and want to change which one is the default.
                </p>
              </HelpSection>
              <HelpSection title="Status meanings">
                <p>
                  <strong>CONNECTED</strong> — working normally. <strong>AUTHENTICATION_REQUIRED</strong>
                  {" "}— scan the QR code shown on the card. <strong>RECONNECTING</strong> — temporarily
                  re-establishing the session, usually resolves on its own. <strong>DISCONNECTED</strong>
                  {" "}— logged out; reconnect or scan a new QR. <strong>SESSION_ERROR</strong> /{" "}
                  <strong>ERROR</strong> — something failed; try Reconnect, and check System Logs if it
                  keeps happening.
                </p>
              </HelpSection>
              <HelpSection title="Reconnect vs. Logout">
                <p>
                  <strong>Reconnect</strong> tries to restore the existing session without losing it —
                  safe to use any time a card looks stuck. <strong>Logout</strong> permanently ends the
                  session and requires a brand-new QR scan afterward — only use it if you actually want to
                  switch which WhatsApp number is connected.
                </p>
              </HelpSection>
              <HelpSection title="Deleting an account">
                <p>
                  You can't delete the only account, and you can't delete the current Primary account —
                  set a different account as Primary first. Deleting removes that account's synced
                  groups and message history permanently.
                </p>
              </HelpSection>
            </HelpButton>
            <AddAccountDialog />
          </>
        }
      />

      {workerOffline ? (
        <div className="mb-6">
          <Alert tone="danger" title="The worker is not responding">
            {lastHeartbeatMs === null
              ? "It has never checked in. Nothing on this page will take effect until it is running — actions are queued for it, not performed here."
              : `Last seen ${workerSilentForMinutes === 0 ? "under a minute" : `${workerSilentForMinutes} minute(s)`} ago. Connecting, reconnecting and logging out all queue work for the worker, so they will appear to succeed and then do nothing until it is back.`}
          </Alert>
        </div>
      ) : pendingCommands > 0 ? (
        <div className="mb-6">
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
              onReconnect={requestReconnect.bind(null, account.id)}
              onResync={requestGroupResync.bind(null, account.id)}
              onLogout={requestLogout.bind(null, account.id)}
              onSetPrimary={setPrimaryAccount.bind(null, account.id)}
              onRemovePrimary={removePrimaryAccount.bind(null, account.id)}
              onDelete={deleteWhatsAppAccount.bind(null, account.id)}
            />
          ))}
        </div>
      )}

      {/* A live QR rotates every few seconds, so it gets a tighter interval than a command
          waiting its turn in the queue. */}
      {shouldPoll ? <AutoRefresh intervalMs={isSettling ? 3000 : 5000} /> : null}
    </div>
  );
}
