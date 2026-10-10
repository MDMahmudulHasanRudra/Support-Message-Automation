"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FileSpreadsheet, RefreshCw, Unplug } from "lucide-react";
import { Badge, Button, ButtonLink, Card, ConfirmDialog, useToast } from "@/components/ui";
import { disconnectGoogleAccountAction, refreshGoogleSpreadsheetsAction } from "@/server/actions/googleSheets";
import Link from "@/components/ProjectLink";
import type { PublicGoogleAccount } from "@/server/google/accounts";

const STATUS: Record<PublicGoogleAccount["status"], { label: string; color: "green" | "yellow" | "gray" }> = {
  CONNECTED: { label: "Connected", color: "green" },
  NEEDS_RECONNECT: { label: "Needs reconnecting", color: "yellow" },
  DISCONNECTED: { label: "Disconnected", color: "gray" },
};

function when(value: Date | null): string {
  return value ? new Date(value).toLocaleString() : "";
}

/**
 * The project's connected Google accounts. Only public fields ever reach this component. Counting stops
 * at `countCap`, so a count that reached it is shown as "at least" rather than as an exact figure.
 */
export function GoogleAccountList({
  accounts,
  canManage,
  configured,
  countCap,
}: {
  accounts: PublicGoogleAccount[];
  canManage: boolean;
  configured: boolean;
  countCap: number;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PublicGoogleAccount | null>(null);

  function run(id: string, action: () => Promise<{ error?: string; success?: string }>) {
    setBusyId(id);
    startTransition(async () => {
      const result = await action();
      setBusyId(null);
      setConfirming(null);
      if (result.error) showToast({ tone: "danger", title: result.error });
      else showToast({ tone: "success", title: result.success ?? "Done" });
      router.refresh();
    });
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <FileSpreadsheet className="size-8 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <p className="text-[14px] font-medium text-[color:var(--color-foreground)]">No Google account connected yet</p>
          <p className="max-w-md text-[13px] text-[color:var(--color-muted-foreground)]">
            {configured
              ? "Connect the Google account your team's spreadsheets are in. You can connect several."
              : "Once this project's Google OAuth client is saved (above) and the integration is on, connect the Google account your team's spreadsheets are in."}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <ul className="space-y-3">
        {accounts.map((account) => {
          const status = STATUS[account.status];
          const busy = pending && busyId === account.id;
          return (
            <li key={account.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-start gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-neutral-bg)] text-[14px] font-semibold text-[color:var(--color-neutral-fg)]">
                    {(account.displayName ?? account.email).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-[color:var(--color-foreground)]">{account.email}</span>
                      <Badge color={status.color} dot>
                        {status.label}
                      </Badge>
                    </div>
                    {account.displayName ? <p className="text-[12px] text-[color:var(--color-muted-foreground)]">{account.displayName}</p> : null}
                    <p className="mt-2 text-[13px] text-[color:var(--color-foreground)]">
                      {account.status === "CONNECTED" && account.spreadsheetCount !== null ? (
                        <>
                          <strong>
                            {account.spreadsheetCount.toLocaleString("en-US")}
                            {account.spreadsheetCount >= countCap ? "+" : ""}
                          </strong>{" "}
                          spreadsheet{account.spreadsheetCount === 1 ? "" : "s"} accessible
                          <span className="text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                            {" "}
                            · checked {when(account.spreadsheetsCountedAt)}
                          </span>
                          {account.spreadsheetCount > 0 ? (
                            <>
                              {" "}
                              ·{" "}
                              <Link href={`/google-sheets?accountId=${account.id}`} className="font-medium text-[color:var(--color-accent)] hover:underline">
                                View
                              </Link>
                            </>
                          ) : null}
                        </>
                      ) : account.status === "CONNECTED" ? (
                        <span className="text-[color:var(--color-muted-foreground)]">Spreadsheet list not read yet — press Refresh.</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                      {account.status === "DISCONNECTED"
                        ? `Disconnected ${when(account.disconnectedAt)}${account.disconnectedByUsername ? ` by ${account.disconnectedByUsername}` : ""}.`
                        : `Connected ${when(account.connectedAt)}${account.connectedBy ? ` by ${account.connectedBy.name}` : ""}.`}
                    </p>
                    {account.status === "CONNECTED" ? (
                      <p className="mt-1 text-[12px] text-[color:var(--color-muted-foreground)]">
                        {account.grantedScopes.includes("https://www.googleapis.com/auth/drive.activity.readonly")
                          ? "Can read who changed monitored spreadsheets in Google directly."
                          : "Cannot read changes made in Google directly — connect it again and allow “activity” on Google's screen."}
                      </p>
                    ) : null}
                    {account.lastError ? <p className="mt-2 text-[12px] font-medium text-[color:var(--color-danger-fg)]">{account.lastError}</p> : null}
                  </div>

                  {canManage ? (
                    // On a phone the actions take their own row (aligned under the text) instead of squeezing it.
                    <div className="flex w-full flex-wrap items-center gap-2 pl-14 sm:w-auto sm:pl-0">
                      {account.status === "CONNECTED" ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            disabled={!configured}
                            onClick={() => run(account.id, () => refreshGoogleSpreadsheetsAction(account.id))}
                          >
                            <RefreshCw className="size-3.5" aria-hidden />
                            Refresh
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirming(account)}>
                            <Unplug className="size-3.5" aria-hidden />
                            Disconnect
                          </Button>
                        </>
                      ) : configured ? (
                        <ButtonLink href="/api/google-sheets/connect" size="sm">
                          Connect again
                        </ButtonLink>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => confirming && run(confirming.id, () => disconnectGoogleAccountAction(confirming.id))}
        title={confirming ? `Disconnect ${confirming.email}?` : ""}
        description="The app stops using this Google account and asks Google to forget its access. Spreadsheets only this account reached move to “No longer reachable”. Its history in the app is kept, and you can connect it again any time."
        confirmLabel="Disconnect"
        tone="danger"
        loading={pending}
      />
    </>
  );
}
