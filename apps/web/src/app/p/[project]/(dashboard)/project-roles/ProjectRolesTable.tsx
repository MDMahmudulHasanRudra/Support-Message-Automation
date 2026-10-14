"use client";

import { useState, useTransition } from "react";
import Link, { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, ConfirmDialog, EmptyState, Table, Td, Th, useToast } from "@/components/ui";
import { deleteProjectRole } from "@/server/actions/projectAdmin";
import type { ProjectRoleView } from "@/server/projectAdmin";

export function ProjectRolesTable({ roles }: { roles: ProjectRoleView[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [target, setTarget] = useState<ProjectRoleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (roles.length === 0) return <EmptyState>No project roles yet. Create one, then give it to the members of this project.</EmptyState>;

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Role</Th>
            <Th>Permissions</Th>
            <Th>Members</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id}>
              <Td>
                <div className="font-medium">{role.name}</div>
                {role.description ? <div className="text-xs text-[color:var(--color-muted-foreground)]">{role.description}</div> : null}
              </Td>
              <Td>{role.permissionKeys.length}</Td>
              <Td>{role.memberCount}</Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  <Link href={`/project-roles/${role.id}`}>
                    <Button size="sm" variant="secondary">
                      Edit
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setTarget(role);
                      setError(null);
                    }}
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
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={() =>
          startTransition(async () => {
            const result = await deleteProjectRole(target!.id);
            if (result.error) {
              setError(result.error);
              return;
            }
            setTarget(null);
            showToast({ tone: "success", title: result.success ?? "Deleted" });
            router.refresh();
          })
        }
        loading={pending}
        tone="danger"
        title={`Delete "${target?.name}"?`}
        description="Only a role nobody holds can be deleted, so nobody loses access by surprise."
        confirmLabel="Delete"
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </ConfirmDialog>
    </>
  );
}
