"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deleteAiProvider, testAiProviderConnection, toggleAiProviderStatus } from "@/server/actions/aiProviders";

export interface AiProviderRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  modelCount: number;
  /** When the last definitive verdict landed — from a Test press or a real AI call. */
  lastVerdictAtLabel: string | null;
  lastVerdictOk: boolean | null;
  lastVerdictError: string | null;
  /** Rate limits, outages, dropped connections — never a reason to call the provider misconfigured. */
  transientCount: number;
  transientLatestLabel: string | null;
  transientWindowHours: number;
}

export function AiProvidersTable({ providers }: { providers: AiProviderRow[] }) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<AiProviderRow | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [isTesting, startTest] = useTransition();
  const [testResult, setTestResult] = useState<{ name: string; ok: boolean; text: string } | null>(null);
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

  function test(row: AiProviderRow) {
    setTestingId(row.id);
    setTestResult(null);
    startTest(async () => {
      const result = await testAiProviderConnection(row.id);
      // The action already stores the verdict, but what it verified — credentials only, or a real
      // completion with a named model — only exists in this return value, and that distinction is
      // the entire point of pressing the button.
      setTestResult({
        name: row.name,
        ok: result.ok,
        text: result.ok ? (result.message ?? "The connection works.") : (result.error ?? "The test failed."),
      });
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
    <div className="space-y-3">
      {testResult ? (
        <Alert tone={testResult.ok ? "success" : "danger"} title={`${testResult.name}: ${testResult.ok ? "connection verified" : "test failed"}`}>
          {testResult.text}
        </Alert>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Status</Th>
            <Th>Models Using</Th>
            <Th>Last verdict</Th>
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
                <div className="flex flex-col items-start gap-1">
                  {p.lastVerdictAtLabel ? (
                    <>
                      <Badge color={p.lastVerdictOk ? "green" : "red"} dot>
                        {/* "Working"/"Rejected", not "OK"/"Failed": this verdict now comes from
                            production traffic as often as from the button, so it has to read as a
                            statement about the provider rather than about a test run. */}
                        {p.lastVerdictOk ? "Working" : "Rejected"}
                      </Badge>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{p.lastVerdictAtLabel}</span>
                      {!p.lastVerdictOk && p.lastVerdictError ? (
                        <span className="max-w-xs text-xs text-[color:var(--color-danger-fg)]">
                          {p.lastVerdictError}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-[color:var(--color-muted-foreground)]">No verdict yet</span>
                  )}
                  {p.transientCount > 0 ? (
                    <span
                      className="text-xs text-[color:var(--color-warning-fg)]"
                      title={`Latest ${p.transientLatestLabel}`}
                    >
                      {p.transientCount} temporary {p.transientCount === 1 ? "failure" : "failures"} in{" "}
                      {p.transientWindowHours}h
                    </span>
                  ) : null}
                </div>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={isTesting && testingId === p.id}
                    onClick={() => test(p)}
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

      <p className="text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">
        <strong className="font-medium">Last verdict</strong> is the most recent definitive answer
        about a provider&apos;s key, endpoint and model — from the Test Connection button or from a
        real AI call, whichever came later. Rate limits and provider outages are counted separately
        as <strong className="font-medium">temporary failures</strong> and never turn the verdict
        red: they say nothing about whether the configuration is correct. Every one is recorded in
        System Logs under the <code>ai-provider</code> scope.
      </p>

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
