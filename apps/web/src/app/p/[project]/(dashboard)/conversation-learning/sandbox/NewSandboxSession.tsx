"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import { Plus } from "lucide-react";
import { Button, Dialog, Field, Input, Select, useToast } from "@/components/ui";
import { createSandboxSession } from "@/server/actions/sandbox";

export interface SandboxGroupOption {
  id: string;
  name: string;
}

/**
 * Starts a test conversation. The group is optional context — it only supplies the group name
 * the prompt sees and the same-group tie-break in knowledge ranking. Nothing is ever read from
 * or written to that group, which is why it can be left blank.
 */
export function NewSandboxSession({ groups }: { groups: SandboxGroupOption[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [groupId, setGroupId] = useState("");
  const [isPending, startTransition] = useTransition();

  function create() {
    startTransition(async () => {
      const result = await createSandboxSession({ label, groupId: groupId || null });
      if (!result.ok || !result.sessionId) {
        showToast({ tone: "danger", title: "Couldn't start that test", description: result.error });
        return;
      }
      setOpen(false);
      setLabel("");
      setGroupId("");
      router.push(`/conversation-learning/sandbox?session=${result.sessionId}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden />
        New test conversation
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New test conversation"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={isPending} onClick={create}>
              Start
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="What are you testing?" hint="Optional — just a name so you can find this again.">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. billing question with no client ID"
            />
          </Field>
          <Field
            label="Answer as if the message came from"
            hint="Optional. Only affects the group name the AI sees and which knowledge ranks first. No message is ever sent to this group."
          >
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">No group (direct message)</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  );
}
