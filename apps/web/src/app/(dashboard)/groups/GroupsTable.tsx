"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";
import { bulkSetMonitoring, requestGroupParticipantCount, toggleGroupMonitoring } from "@/server/actions/groups";

export interface GroupRow {
  id: string;
  name: string;
  accountLabel: string;
  isMonitored: boolean;
  isActive: boolean;
  participantCount: number | null;
  lastSyncedAt: string | null;
}

export function GroupsTable({ groups }: { groups: GroupRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allVisibleSelected = useMemo(
    () => groups.length > 0 && groups.every((g) => selected.has(g.id)),
    [groups, selected],
  );

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        groups.forEach((g) => next.delete(g.id));
        return next;
      }
      const next = new Set(prev);
      groups.forEach((g) => next.add(g.id));
      return next;
    });
  }

  async function handleBulk(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await bulkSetMonitoring([...selected], enabled);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{selected.size} selected</span>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy || selected.size === 0} onClick={() => handleBulk(true)}>
            Bulk Enable Monitoring
          </Button>
          <Button variant="secondary" disabled={busy || selected.size === 0} onClick={() => handleBulk(false)}>
            Bulk Disable Monitoring
          </Button>
        </div>
      </div>
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              </th>
              <Th>Group</Th>
              <Th>Account</Th>
              <Th>Monitored</Th>
              <Th>Status</Th>
              <Th>Participants</Th>
              <Th>Last Synced</Th>
              <Th>Manage</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <Td>
                  <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggleOne(g.id)} />
                </Td>
                <Td>{g.name}</Td>
                <Td>{g.accountLabel}</Td>
                <Td>
                  <Badge color={g.isMonitored ? "green" : "gray"}>{g.isMonitored ? "Monitored" : "Not Monitored"}</Badge>
                </Td>
                <Td>
                  <Badge color={g.isActive ? "blue" : "yellow"}>{g.isActive ? "Active" : "Inactive"}</Badge>
                </Td>
                <Td>
                  {g.participantCount !== null ? (
                    g.participantCount
                  ) : (
                    <form action={requestGroupParticipantCount.bind(null, g.id)}>
                      <button type="submit" className="text-xs underline">
                        Fetch
                      </button>
                    </form>
                  )}
                </Td>
                <Td>{g.lastSyncedAt ? new Date(g.lastSyncedAt).toLocaleString() : "—"}</Td>
                <Td>
                  <form action={toggleGroupMonitoring.bind(null, g.id)}>
                    <Button variant="secondary" type="submit">
                      {g.isMonitored ? "Stop Monitoring" : "Start Monitoring"}
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="border-b border-zinc-100 px-4 py-2 text-zinc-800 dark:border-zinc-900 dark:text-zinc-200">{children}</td>;
}
