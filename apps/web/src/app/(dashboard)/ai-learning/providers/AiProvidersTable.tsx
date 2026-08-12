"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deleteAiProvider, testAiProviderConnection, toggleAiProviderStatus } from "@/server/actions/aiProviders";

export interface AiProviderRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  modelCount: number;
  lastTestedAtLabel: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export function AiProvidersTable({ providers }: { providers: AiProviderRow[] }) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<AiProviderRow | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [isTesting, startTest] = useTransition();
  const [toggleId, setToggleId] = useState<string | null>(null);
  const [isToggling, startToggle] = useTransition();

  function confirmDelete() {
    if (!deleteTarget) return;
    startSubmit(async () => {
      await deleteAiProvider(deleteTarget.id);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  function test(id: string) {
    setTestingId(id);
    startTest(async () => {
      await testAiProviderConnection(id);
      router.refresh();
    });
  }

  function toggle(id: string) {
    setToggleId(id);
    startToggle(async () => {
      await toggleAiProviderStatus(id);
      router.refresh();
    });
  }

  if (providers.length === 0) {
    return <EmptyState>No AI providers configured yet. Add one to get started.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Status</Th>
            <Th>Models Using</Th>
            <Th>Last Connection Test</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <Td>{p.name}</Td>
              <Td>{p.kind}</Td>
              <Td>
                <Badge color={p.status === "ACTIVE" ? "green" : "gray"} dot>
                  {p.status}
                </Badge>
              </Td>
              <Td className="tabular-nums">{p.modelCount}</Td>
              <Td>
                {p.lastTestedAtLabel ? (
                  <div className="flex flex-col gap-0.5">
                    <Badge color={p.lastTestOk ? "green" : "red"} dot>
                      {p.lastTestOk ? "OK" : "Failed"}
                    </Badge>
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">{p.lastTestedAtLabel}</span>
                    {!p.lastTestOk && p.lastTestError ? (
                      <span className="max-w-xs text-xs text-[color:var(--color-danger-fg)]">{p.lastTestError}</span>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-[color:var(--color-muted-foreground)]">Never tested</span>
                )}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={isTesting && testingId === p.id}
                    onClick={() => test(p.id)}
                  >
                    Test Connection
                  </Button>
                  <Link href={`/ai-learning/providers/${p.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={isToggling && toggleId === p.id}
                    onClick={() => toggle(p.id)}
                  >
                    {p.status === "ACTIVE" ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleteTarget(p)}>
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        loading={isSubmitting}
        tone="danger"
        title={`Delete provider "${deleteTarget?.name}"?`}
        description="Any AI Models assigned to this provider will need to be reassigned. This cannot be undone."
        confirmLabel="Delete"
      />
    </div>
  );
}
