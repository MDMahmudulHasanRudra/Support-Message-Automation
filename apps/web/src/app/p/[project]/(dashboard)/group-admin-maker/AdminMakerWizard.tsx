"use client";

import { useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Card, Field, Input, Select, useToast } from "@/components/ui";
import { startGroupAdminPromotion } from "@/server/actions/groupAdminPromotion";

export interface AdminMakerAccount {
  id: string;
  label: string;
  status: string;
  groupCount: number;
}

/**
 * Step 1: a connected account. Step 2: the member's number. "Check groups" creates the background
 * job and opens it — the work itself runs in the worker, so leaving the page changes nothing.
 */
export function AdminMakerWizard({ accounts }: { accounts: AdminMakerAccount[] }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const connected = accounts.filter((a) => a.status === "CONNECTED");
  const [step, setStep] = useState<1 | 2>(1);
  // A connected account that actually has groups, when there is one — an empty one can only refuse.
  const [accountId, setAccountId] = useState((connected.find((a) => a.groupCount > 0) ?? connected[0])?.id ?? "");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const account = accounts.find((a) => a.id === accountId);

  function check() {
    setError(null);
    startTransition(async () => {
      const result = await startGroupAdminPromotion({ accountId, phoneNumber: phone });
      if (result.error || !result.jobId) {
        setError(result.error ?? "The job could not be started.");
        return;
      }
      if (result.existing) {
        showToast({ tone: "info", title: "Already running", description: "This number already has a job running on this account — showing that one." });
      }
      router.push(`/group-admin-maker/jobs/${result.jobId}`);
    });
  }

  return (
    <Card className="p-5">
      <p className="text-xs font-medium tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase">Step {step} of 2</p>
      {step === 1 ? (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[color:var(--color-foreground)]">Select account</h2>
          {connected.length === 0 ? (
            <div className="mt-3">
              <Alert tone="warning">
                No WhatsApp account is connected. Connect one on WhatsApp Accounts — the groups can only be checked through a live session.
              </Alert>
            </div>
          ) : null}
          <div className="mt-3 max-w-xl">
            <Field label="WhatsApp account">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={connected.length === 0}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={a.status !== "CONNECTED"}>
                    {a.label} ({a.status}) — {a.groupCount.toLocaleString("en-US")} synchronized group(s)
                    {a.status === "CONNECTED" ? "" : " — not connected"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="button" onClick={() => setStep(2)} disabled={!account || account.status !== "CONNECTED"}>
              Next
            </Button>
          </div>
        </>
      ) : (
        <>
          <h2 className="mt-1 text-sm font-semibold text-[color:var(--color-foreground)]">Target number</h2>
          <p className="mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
            Account: <strong className="font-medium text-[color:var(--color-foreground)]">{account?.label}</strong>
          </p>
          <div className="mt-3 max-w-md">
            <Field
              label="Phone number"
              hint="This number must already be a member of the groups where you want to make them an admin. It is never added to a group. +8801XXXXXXXXX, 8801XXXXXXXXX and 01XXXXXXXXX all work."
            >
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+8801XXXXXXXXX"
                inputMode="tel"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phone.trim()) check();
                }}
              />
            </Field>
          </div>
          {error ? (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setStep(1)} disabled={pending}>
              Back
            </Button>
            <Button type="button" onClick={check} loading={pending} disabled={!phone.trim()}>
              Check groups
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
