"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { revokeAllOtherSessions, revokeSession } from "@/server/actions/sessions";

export interface SessionRow {
  id: string;
  deviceLabel: string;
  ipAddress: string | null;
  lastActiveLabel: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  isCurrentDevice: boolean;
}

export function SessionsTable({ userId, sessions }: { userId: string; sessions: SessionRow[] }) {
  const router = useRouter();
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);
  const [isRevoking, startRevoke] = useTransition();
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [isRevokingAll, startRevokeAll] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const activeCount = sessions.filter((s) => s.status === "ACTIVE").length;

  function confirmRevoke() {
    if (!revokeTarget) return;
    startRevoke(async () => {
      const result = await revokeSession(revokeTarget.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setRevokeTarget(null);
      router.refresh();
    });
  }

  function confirmRevokeAllOther() {
    startRevokeAll(async () => {
      const result = await revokeAllOtherSessions(userId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setRevokeAllOpen(false);
      router.refresh();
    });
  }

  if (sessions.length === 0) {
    return <EmptyState>No sessions recorded for this user yet.</EmptyState>;
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" disabled={activeCount < 2} onClick={() => setRevokeAllOpen(true)}>
          Logout All Other Devices
        </Button>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Device</Th>
            <Th>IP Address</Th>
            <Th>Last Active</Th>
            <Th>Status</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{s.deviceLabel}</span>
                  {s.isCurrentDevice ? <Badge color="blue">CURRENT DEVICE</Badge> : null}
                </div>
              </Td>
              <Td>{s.ipAddress ?? "—"}</Td>
              <Td>{s.lastActiveLabel}</Td>
              <Td>
                <Badge color={s.status === "ACTIVE" ? "green" : s.status === "EXPIRED" ? "gray" : "red"} dot>
                  {s.status}
                </Badge>
              </Td>
              <Td>
                {s.status === "ACTIVE" ? (
                  <Button variant="danger" size="sm" onClick={() => setRevokeTarget(s)}>
                    Logout
                  </Button>
                ) : (
                  <span className="text-[color:var(--color-muted-foreground)]">—</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        loading={isRevoking}
        tone="danger"
        title="Log out this device?"
        description={
          revokeTarget?.isCurrentDevice
            ? "This is your current device — you will be signed out immediately."
            : "That device will be signed out on its next request."
        }
        confirmLabel="Logout"
      />

      <ConfirmDialog
        open={revokeAllOpen}
        onClose={() => setRevokeAllOpen(false)}
        onConfirm={confirmRevokeAllOther}
        loading={isRevokingAll}
        tone="danger"
        title="Logout all other devices?"
        description="Every other active session for this user will be signed out. The current device (if it belongs to this user) is not affected."
        confirmLabel="Logout All Other Devices"
      />
    </div>
  );
}
