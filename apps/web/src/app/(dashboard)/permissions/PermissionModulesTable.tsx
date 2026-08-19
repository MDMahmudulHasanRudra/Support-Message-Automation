"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Table, Td, Th } from "@/components/ui";
import { deletePermissionModule } from "@/server/actions/permissionModules";

export interface PermissionModuleRow {
  id: string;
  name: string;
  description: string | null;
  userCount: number;
  permissionCount: number;
  isSystem: boolean;
}

export function PermissionModulesTable({ modules }: { modules: PermissionModuleRow[] }) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<PermissionModuleRow | null>(null);
  const [isDeleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function confirmDelete() {
    if (!deleteTarget) return;
    startDelete(async () => {
      const result = await deletePermissionModule(deleteTarget.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  if (modules.length === 0) {
    return <EmptyState>No Permission Modules yet.</EmptyState>;
  }

  return (
    <div>
      {error ? <div className="mb-3"><Alert tone="danger">{error}</Alert></div> : null}
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Users</Th>
            <Th>Permissions</Th>
            <Th>Status</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <tr key={m.id}>
              <Td>
                <div className="flex flex-col">
                  <span>{m.name}</span>
                  {m.description ? (
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">{m.description}</span>
                  ) : null}
                </div>
              </Td>
              <Td className="tabular-nums">{m.userCount}</Td>
              <Td className="tabular-nums">{m.permissionCount}</Td>
              <Td>
                {m.isSystem ? <Badge color="blue">Default</Badge> : <Badge color="gray">Custom</Badge>}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/permissions/${m.id}/edit`}>
                    <Button variant="secondary" size="sm">
                      Edit
                    </Button>
                  </Link>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={m.isSystem}
                    onClick={() => setDeleteTarget(m)}
                  >
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
        loading={isDeleting}
        tone="danger"
        title={`Delete "${deleteTarget?.name}"?`}
        description={
          deleteTarget && deleteTarget.userCount > 0
            ? `This module is assigned to ${deleteTarget.userCount} user(s) — it cannot be deleted until they're reassigned.`
            : "This cannot be undone."
        }
        confirmLabel="Delete"
      />
    </div>
  );
}
