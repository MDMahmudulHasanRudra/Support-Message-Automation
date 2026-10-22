"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, ConfirmDialog, Field, Select } from "@/components/ui";
import { abandonClientImport, cancelClientImport, confirmClientImport, remapClientImport } from "@/server/actions/clientImport";
import { CLIENT_DUPLICATE_POLICIES, CLIENT_DUPLICATE_POLICY_LABELS, CLIENT_IMPORT_FIELDS } from "@support-automation/shared";

/**
 * Step 2: the preview's controls. The mapping can be changed (and the preview recomputed) as often as
 * needed; the confirmation shows how many clients will be created before it runs, and is claimed once
 * on the server, so a second press or a second tab cannot import the file twice.
 */
export function ImportReview({
  jobId,
  headers,
  mapping,
  willCreate,
  matchExisting,
  invalidCount,
  canConfirm,
}: {
  jobId: string;
  headers: string[];
  mapping: Record<string, string>;
  willCreate: number;
  matchExisting: number;
  invalidCount: number;
  canConfirm: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>(mapping);
  const [policy, setPolicy] = useState<string>("SKIP");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, startTransition] = useTransition();
  const dirty = JSON.stringify(draft) !== JSON.stringify(mapping);

  function saveMapping() {
    startTransition(async () => {
      const r = await remapClientImport(jobId, draft);
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });
  }
  function confirm() {
    startTransition(async () => {
      const r = await confirmClientImport(jobId, policy);
      setConfirming(false);
      setMessage({ ok: r.ok, text: r.message });
      router.refresh();
    });
  }
  function cancel() {
    startTransition(async () => {
      const r = await cancelClientImport(jobId);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.push("/clients/import");
    });
  }

  const touched = policy === "UPDATE" ? matchExisting : policy === "CREATE" ? matchExisting : 0;

  return (
    <div className="space-y-6">
      {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}

      <div>
        <p className="mb-2 text-sm font-medium">Column mapping</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CLIENT_IMPORT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} required={f.required}>
              <Select value={draft[f.key] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}>
                <option value="">{f.required ? "Choose a column…" : "Not in the file"}</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={saveMapping} disabled={!dirty} loading={busy}>
            Apply mapping and refresh preview
          </Button>
        </div>
      </div>

      {canConfirm ? (
        <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <Field label="Rows that match a client you already have">
            <Select value={policy} onChange={(e) => setPolicy(e.target.value)}>
              {CLIENT_DUPLICATE_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {CLIENT_DUPLICATE_POLICY_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            {dirtyNote(dirty)} This will create <strong>{willCreate.toLocaleString()}</strong> new client(s)
            {policy === "SKIP" ? `, skip ${matchExisting.toLocaleString()} match(es)` : policy === "UPDATE" ? `, update ${touched.toLocaleString()} existing client(s)` : `, and create ${touched.toLocaleString()} more even though they match`}
            {invalidCount ? `; ${invalidCount.toLocaleString()} invalid row(s) will not be imported` : ""}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirming(true)} disabled={dirty || busy}>
              Import
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              Cancel import
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={confirm}
        loading={busy}
        title="Start the import?"
        description={`${willCreate.toLocaleString()} client(s) will be created${policy === "UPDATE" ? ` and ${touched.toLocaleString()} updated` : ""}. Do not close this tab until it finishes.`}
        confirmLabel="Import"
      />
    </div>
  );
}

const dirtyNote = (dirty: boolean) => (dirty ? "Apply the mapping change first. " : "");

export function AbandonImport({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      {message ? <Alert tone="info">{message}</Alert> : null}
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        onClick={() =>
          startTransition(async () => {
            const r = await abandonClientImport(jobId);
            setMessage(r.message);
            router.refresh();
          })
        }
      >
        Mark as failed
      </Button>
    </div>
  );
}
