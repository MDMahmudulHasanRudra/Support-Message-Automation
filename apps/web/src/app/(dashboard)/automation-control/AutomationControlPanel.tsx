"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pause, Play } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, SectionHeader } from "@/components/ui";
import { setAutomationEnabled, setAutomationMode } from "@/server/actions/settings";

type AutomationMode = "MANUAL_ONLY" | "SAFE_AUTO_REPLY" | "FULL_RULE_AUTOMATION";

const MODES: Array<{ value: AutomationMode; label: string; description: string }> = [
  { value: "MANUAL_ONLY", label: "Manual Only", description: "Detects and notifies only. No automatic replies." },
  {
    value: "SAFE_AUTO_REPLY",
    label: "Safe Auto Reply (recommended)",
    description: "Only vetted acknowledgement rules may reply.",
  },
  {
    value: "FULL_RULE_AUTOMATION",
    label: "Full Rule Automation",
    description: "All active rules may execute, subject to rate limits.",
  },
];

type DialogState = { kind: "toggle" } | { kind: "mode"; mode: AutomationMode } | null;

export function AutomationControlPanel({
  automationEnabled,
  mode,
  pendingBroadcastCount,
}: {
  automationEnabled: boolean;
  mode: string;
  pendingBroadcastCount: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    if (!dialog) return;
    startTransition(async () => {
      if (dialog.kind === "toggle") await setAutomationEnabled(!automationEnabled);
      if (dialog.kind === "mode") await setAutomationMode(dialog.mode);
      setDialog(null);
      router.refresh();
    });
  }

  const targetMode = dialog?.kind === "mode" ? MODES.find((m) => m.value === dialog.mode) : null;

  return (
    <div className="space-y-6">
      <Card className={automationEnabled ? "" : "border-[var(--color-danger-border)]"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader
            title="Kill Switch"
            description="When paused: no new automatic replies are sent. Incoming messages are still stored and the support team is still notified."
          />
          <Badge color={automationEnabled ? "green" : "red"} dot>
            {automationEnabled ? "ENABLED" : "PAUSED"}
          </Badge>
        </div>
        <div className="mt-4">
          {automationEnabled ? (
            <Button variant="danger" onClick={() => setDialog({ kind: "toggle" })}>
              <Pause className="size-3.5" aria-hidden />
              Pause Automation
            </Button>
          ) : (
            <Button onClick={() => setDialog({ kind: "toggle" })}>
              <Play className="size-3.5" aria-hidden />
              Resume Automation
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Automation Mode" />
        <div className="space-y-3">
          {MODES.map((m) => (
            <div
              key={m.value}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border p-4 transition-colors duration-150 ${
                mode === m.value
                  ? "border-[var(--color-primary)]/50 bg-[var(--color-primary-soft)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              <div>
                <p className="text-sm font-medium text-[color:var(--color-foreground)]">{m.label}</p>
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{m.description}</p>
              </div>
              {mode === m.value ? (
                <Badge color="blue">
                  <Check className="size-3 shrink-0" aria-hidden />
                  Current
                </Badge>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "mode", mode: m.value })}>
                  Select
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog?.kind === "toggle" && automationEnabled ? "danger" : "primary"}
        title={
          dialog?.kind === "toggle"
            ? automationEnabled
              ? "Pause automation?"
              : "Resume automation?"
            : targetMode
              ? `Switch to ${targetMode.label}?`
              : ""
        }
        description={
          dialog?.kind === "toggle"
            ? automationEnabled
              ? pendingBroadcastCount > 0
                ? `This will immediately cancel ${pendingBroadcastCount} pending broadcast message(s) and stop all rule-based auto-replies.`
                : "This stops all rule-based auto-replies. Incoming messages keep being stored and notified."
              : "Rule-based auto-replies and queued broadcasts will resume immediately."
            : targetMode?.description
        }
        confirmLabel={
          dialog?.kind === "toggle" ? (automationEnabled ? "Pause Automation" : "Resume Automation") : "Switch Mode"
        }
      />
    </div>
  );
}
