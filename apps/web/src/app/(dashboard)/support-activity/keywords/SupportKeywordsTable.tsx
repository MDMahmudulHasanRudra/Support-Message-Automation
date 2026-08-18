"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Table, Td, Th } from "@/components/ui";
import { deleteSupportKeyword, toggleSupportKeywordActive, updateSupportKeyword } from "@/server/actions/supportKeywords";

export interface SupportKeywordRow {
  id: string;
  value: string;
  matchMode: string;
  caseSensitive: boolean;
  isActive: boolean;
}

type ConfirmState = { kind: "delete" | "toggle"; keyword: SupportKeywordRow } | null;

export function SupportKeywordsTable({ keywords }: { keywords: SupportKeywordRow[] }) {
  const router = useRouter();
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [editing, setEditing] = useState<SupportKeywordRow | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirmAction() {
    if (!confirmState) return;
    const { kind, keyword } = confirmState;
    startTransition(async () => {
      if (kind === "delete") await deleteSupportKeyword(keyword.id);
      if (kind === "toggle") await toggleSupportKeywordActive(keyword.id);
      setConfirmState(null);
      router.refresh();
    });
  }

  async function saveEdit(formData: FormData) {
    if (!editing) return;
    await updateSupportKeyword(editing.id, formData);
    setEditing(null);
    router.refresh();
  }

  if (keywords.length === 0) {
    return <EmptyState>No support keywords yet — add one above.</EmptyState>;
  }

  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Value</Th>
            <Th>Match Mode</Th>
            <Th>Case Sensitive</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((k) => (
            <tr key={k.id}>
              <Td className="font-medium">{k.value}</Td>
              <Td>{k.matchMode}</Td>
              <Td>{k.caseSensitive ? "Yes" : "No"}</Td>
              <Td>
                <Badge color={k.isActive ? "green" : "gray"} dot>
                  {k.isActive ? "ACTIVE" : "DISABLED"}
                </Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(k)}>
                    Edit
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmState({ kind: "toggle", keyword: k })}>
                    {k.isActive ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setConfirmState({ kind: "delete", keyword: k })}>
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmDialog
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmAction}
        loading={isPending}
        tone={confirmState?.kind === "delete" ? "danger" : "primary"}
        title={
          confirmState?.kind === "delete"
            ? `Delete "${confirmState.keyword.value}"?`
            : confirmState
              ? `${confirmState.keyword.isActive ? "Disable" : "Enable"} "${confirmState.keyword.value}"?`
              : ""
        }
        description={confirmState?.kind === "delete" ? "This also removes it from any rule that references it." : undefined}
        confirmLabel={confirmState?.kind === "delete" ? "Delete" : confirmState?.keyword.isActive ? "Disable" : "Enable"}
      />

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title="Edit Keyword">
        {editing ? (
          <form
            action={(formData) => {
              void saveEdit(formData);
            }}
            className="space-y-4"
          >
            <Field label="Value">
              <Input name="value" defaultValue={editing.value} required />
            </Field>
            <Field label="Match Mode">
              <Select name="matchMode" defaultValue={editing.matchMode}>
                <option value="CONTAINS">Contains</option>
                <option value="EXACT">Exact</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="caseSensitive" defaultChecked={editing.caseSensitive} />
              Case sensitive
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
