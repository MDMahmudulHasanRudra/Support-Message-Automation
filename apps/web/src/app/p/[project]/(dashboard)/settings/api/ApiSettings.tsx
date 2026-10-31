"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { API_SCOPE_LABELS, API_SCOPES, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, SectionHeader, Select, Table, Td, Th, useToast } from "@/components/ui";
import { createApiKey, deleteWebhookEndpoint, retryWebhookDelivery, revokeApiKey, rotateWebhookSecret, saveWebhookEndpoint, sendTestWebhook } from "@/server/actions/integrationHub";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdByUsername: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  deliveries: Array<{ id: string; event: string; status: string; attempts: number; lastStatusCode: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null }>;
}

const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—");
const DELIVERY_COLOR: Record<string, "green" | "yellow" | "red" | "blue"> = { SUCCEEDED: "green", PENDING: "yellow", SENDING: "blue", DEAD: "red" };

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string; success?: string; secret?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) setError(r.error);
      else {
        showToast({ tone: "success", title: r.success ?? "Done" });
        if (r.secret) setSecret(r.secret);
        after?.();
      }
      router.refresh();
    });
  };
  return { pending, error, secret, setSecret, run };
}

function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <Alert tone="warning" title="Copy this now — it is not shown again" actions={<Button size="sm" variant="secondary" onClick={onDone}>I have copied it</Button>}>
      <Input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} className="mt-2 font-[family-name:var(--font-mono)] text-xs" />
    </Alert>
  );
}

export function ApiKeysPanel({ keys, apiBase }: { keys: ApiKeyRow[]; apiBase: string | null }) {
  const { pending, error, secret, setSecret, run } = useRun();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  return (
    <Card>
      <SectionHeader title="API keys" description={`Each key works for this workspace only, with the permissions chosen here.${apiBase ? ` Base address: ${apiBase}` : ""}`} />
      {secret ? <SecretOnce secret={secret} onDone={() => setSecret(null)} /> : null}
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createApiKey(name, scopes, expires ? Number(expires) : null), () => {
            setName("");
            setScopes([]);
          });
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="n8n, Website, ERP…" maxLength={80} />
          </Field>
          <Field label="Expires">
            <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {API_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2">
              <Checkbox checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
              {API_SCOPE_LABELS[s]}
            </label>
          ))}
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" loading={pending}>
          Create key
        </Button>
      </form>
      {keys.length ? (
        <div className="mt-4">
          <Table>
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>Permissions</Th>
                <Th>Last used</Th>
                <Th>State</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <Td>
                    <span className="font-medium">{k.name}</span>
                    <span className="block font-[family-name:var(--font-mono)] text-xs text-[color:var(--color-muted-foreground)]">{k.prefix}…</span>
                  </Td>
                  <Td className="text-xs">{k.scopes.map((s) => API_SCOPE_LABELS[s as keyof typeof API_SCOPE_LABELS] ?? s).join(", ")}</Td>
                  <Td className="whitespace-nowrap text-xs">{when(k.lastUsedAt)}</Td>
                  <Td>
                    {k.revokedAt ? <Badge color="gray">Revoked</Badge> : k.expiresAt && new Date(k.expiresAt) < new Date() ? <Badge color="gray">Expired</Badge> : <Badge color="green">Active</Badge>}
                    {k.expiresAt && !k.revokedAt ? <span className="block text-xs text-[color:var(--color-muted-foreground)]">until {when(k.expiresAt)}</span> : null}
                  </Td>
                  <Td>
                    {!k.revokedAt ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        tone="danger"
        loading={pending}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Anything using this key is refused from now on. This cannot be undone; create a new key instead."
        confirmLabel="Revoke"
        onConfirm={() => revoking && run(() => revokeApiKey(revoking.id), () => setRevoking(null))}
      />
    </Card>
  );
}

function EndpointEditor({ endpoint, onDone }: { endpoint: EndpointRow | null; onDone: () => void }) {
  const { pending, error, secret, setSecret, run } = useRun();
  const [form, setForm] = useState({ url: endpoint?.url ?? "", description: endpoint?.description ?? "", events: endpoint?.events ?? [...WEBHOOK_EVENTS], isActive: endpoint?.isActive ?? true });
  return (
    <form
      className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveWebhookEndpoint(endpoint?.id ?? null, form), () => {
          if (endpoint) onDone();
        });
      }}
    >
      {secret ? <SecretOnce secret={secret} onDone={() => { setSecret(null); onDone(); }} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Address" hint="https:// only, a public address.">
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://n8n.example.com/webhook/…" required />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={200} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {WEBHOOK_EVENTS.map((ev) => (
          <label key={ev} className="flex items-center gap-2">
            <Checkbox checked={form.events.includes(ev)} onChange={(e) => setForm((f) => ({ ...f, events: e.target.checked ? [...f.events, ev] : f.events.filter((x) => x !== ev) }))} />
            <span>
              <span className="font-[family-name:var(--font-mono)] text-xs">{ev}</span> — {WEBHOOK_EVENT_LABELS[ev]}
            </span>
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Send to this endpoint
      </label>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          {endpoint ? "Save" : "Add endpoint"}
        </Button>
        {endpoint ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function WebhooksPanel({ endpoints }: { endpoints: EndpointRow[] }) {
  const { pending, error, secret, setSecret, run } = useRun();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EndpointRow | null>(null);
  return (
    <Card>
      <SectionHeader
        title="Webhooks"
        description="Events are POSTed as JSON, signed in X-GetAssist-Signature (t=<seconds>,v1=<HMAC-SHA256 of “t.body”>). Failed deliveries are retried for a day; receivers should deduplicate on X-GetAssist-Event-Id."
      />
      {secret ? <SecretOnce secret={secret} onDone={() => setSecret(null)} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="space-y-4">
        {endpoints.map((ep) =>
          editing === ep.id ? (
            <EndpointEditor key={ep.id} endpoint={ep} onDone={() => setEditing(null)} />
          ) : (
            <div key={ep.id} className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all font-[family-name:var(--font-mono)] text-xs">{ep.url}</span>
                <Badge color={ep.isActive ? "green" : "gray"}>{ep.isActive ? "Sending" : "Off"}</Badge>
              </div>
              {ep.description ? <p className="text-sm">{ep.description}</p> : null}
              <p className="text-xs text-[color:var(--color-muted-foreground)]">{ep.events.join(", ")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(ep.id)}>
                  Edit
                </Button>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => sendTestWebhook(ep.id))}>
                  Send test
                </Button>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => rotateWebhookSecret(ep.id))}>
                  New secret
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(ep)}>
                  Delete
                </Button>
              </div>
              {ep.deliveries.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Event</Th>
                      <Th>Result</Th>
                      <Th>Tries</Th>
                      <Th>Detail</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {ep.deliveries.map((d) => (
                      <tr key={d.id}>
                        <Td className="whitespace-nowrap text-xs">{when(d.createdAt)}</Td>
                        <Td className="font-[family-name:var(--font-mono)] text-xs">{d.event}</Td>
                        <Td>
                          <Badge color={DELIVERY_COLOR[d.status] ?? "yellow"}>{d.status === "DEAD" ? "gave up" : d.status.toLowerCase()}</Badge>
                        </Td>
                        <Td className="tabular text-xs">{d.attempts}</Td>
                        <Td className="text-xs">
                          {d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : ""} {d.lastError ?? ""}
                          {d.status === "DEAD" ? (
                            <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => retryWebhookDelivery(d.id))}>
                              Retry
                            </Button>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="text-xs text-[color:var(--color-muted-foreground)]">Nothing sent yet.</p>
              )}
            </div>
          ),
        )}
        <EndpointEditor endpoint={null} onDone={() => undefined} />
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        loading={pending}
        title="Delete this endpoint?"
        description="Nothing more is sent to it, and its delivery history is deleted."
        confirmLabel="Delete"
        onConfirm={() => deleting && run(() => deleteWebhookEndpoint(deleting.id), () => setDeleting(null))}
      />
    </Card>
  );
}
