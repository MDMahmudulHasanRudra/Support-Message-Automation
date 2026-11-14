"use client";

import { useState } from "react";
import { Link2, Sparkles } from "lucide-react";
import { Button, Dialog, Input, Label, FieldHint } from "@/components/ui";
import type { ConnectInput } from "@/server/actions/businessApps";

type Mode = "PROVISION_NEW" | "LINK_EXISTING";

const MODES: Array<{ key: Mode; title: string; body: string; icon: typeof Sparkles }> = [
  {
    key: "LINK_EXISTING",
    title: "Use an existing workspace",
    body: "The store already runs in Commerce. Paste its workspace id from Commerce → Settings → Integration.",
    icon: Link2,
  },
  {
    key: "PROVISION_NEW",
    title: "Create a new workspace",
    body: "Commerce creates an empty store for this project. Someone must then be added to it in Commerce before it can be opened.",
    icon: Sparkles,
  },
];

/**
 * How a Main Admin first connects an app that has no workspace yet: link the store that already exists, or
 * have the app create one. The values are checked again on the server; nothing here is trusted.
 */
export function ConnectAppDialog({
  open,
  appName,
  loading,
  onClose,
  onConnect,
}: {
  open: boolean;
  appName: string;
  loading: boolean;
  onClose: () => void;
  onConnect: (input: ConnectInput) => void;
}) {
  const [mode, setMode] = useState<Mode>("LINK_EXISTING");
  const [workspaceId, setWorkspaceId] = useState("");
  const [currency, setCurrency] = useState("BDT");
  const ready = mode === "PROVISION_NEW" ? /^[A-Za-z]{3}$/.test(currency.trim()) : workspaceId.trim().length >= 32;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Connect ${appName}`}
      description={`This project's ${appName} data stays in ${appName}. This server keeps one read-only key for it, encrypted.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={!ready}
            onClick={() => onConnect(mode === "PROVISION_NEW" ? { mode, currency: currency.trim().toUpperCase() } : { mode, workspaceId: workspaceId.trim() })}
          >
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div role="radiogroup" aria-label="How to connect" className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => {
            const selected = mode === m.key;
            const Icon = m.icon;
            return (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(m.key)}
                className={`flex flex-col gap-1.5 rounded-[var(--radius-md)] border px-3.5 py-3 text-left transition-colors ${
                  selected ? "border-[var(--color-accent)] bg-[var(--color-accent-bg)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-sunken)]"
                }`}
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-foreground)]">
                  <Icon className="size-4" aria-hidden />
                  {m.title}
                </span>
                <span className="text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">{m.body}</span>
              </button>
            );
          })}
        </div>
        {mode === "LINK_EXISTING" ? (
          <div className="space-y-1.5">
            <Label htmlFor="connect-workspace">Commerce workspace id</Label>
            <Input
              id="connect-workspace"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="621ac1c0-9b9b-4094-ad6c-7151bd582fce"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-[12.5px]"
            />
            <FieldHint>A workspace can be linked to one project only. Commerce refuses one that is already linked.</FieldHint>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="connect-currency">Store currency</Label>
            <Input id="connect-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} className="w-28 uppercase" autoComplete="off" />
            <FieldHint>Three letters, such as BDT or USD. Commerce keeps one currency per workspace.</FieldHint>
          </div>
        )}
      </div>
    </Dialog>
  );
}
