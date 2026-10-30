"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { deleteSocialFeedAction, runSocialFeedAction, saveSocialFeedAction, type SocialAutomationState } from "@/server/actions/socialAutomation";

export interface FeedAccount {
  id: string;
  label: string;
}

export interface FeedValue {
  id?: string;
  name: string;
  url: string;
  accountIds: string[];
  prefix: string;
  includeSummary: boolean;
  intervalMinutes: number;
  enabled: boolean;
}

export function FeedForm({ value, accounts, onDone }: { value: FeedValue; accounts: FeedAccount[]; onDone?: () => void }) {
  const router = useProjectRouter();
  const [state, action, pending] = useActionState<SocialAutomationState, FormData>(saveSocialFeedAction, {});
  useEffect(() => {
    if (state.success) {
      router.refresh();
      onDone?.();
    }
  }, [state.success, router, onDone]);
  const key = value.id ?? "new";
  return (
    <form action={action} className="space-y-3">
      {value.id ? <input type="hidden" name="id" value={value.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`fname-${key}`}>
          <Input id={`fname-${key}`} name="name" defaultValue={value.name} maxLength={120} />
        </Field>
        <Field label="Feed address" htmlFor={`furl-${key}`} hint="An RSS or Atom feed, e.g. https://example.com/feed">
          <Input id={`furl-${key}`} name="url" type="url" defaultValue={value.url} />
        </Field>
        <Field label="Line above each item (optional)" htmlFor={`fprefix-${key}`}>
          <Input id={`fprefix-${key}`} name="prefix" defaultValue={value.prefix} maxLength={300} placeholder="New on our blog:" />
        </Field>
        <Field label="Check every" htmlFor={`fint-${key}`}>
          <Select id={`fint-${key}`} name="intervalMinutes" defaultValue={String(value.intervalMinutes)}>
            {[
              [60, "hour"],
              [180, "3 hours"],
              [360, "6 hours"],
              [720, "12 hours"],
              [1440, "day"],
            ].map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Drafts are prepared for</legend>
        {accounts.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Connect an account first.</p> : null}
        <div className="flex flex-wrap gap-3 text-sm">
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="account" value={a.id} defaultChecked={value.accountIds.includes(a.id)} /> {a.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="includeSummary" defaultChecked={value.includeSummary} /> Include a short summary
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" name="enabled" defaultChecked={value.enabled} /> On
        </label>
      </div>
      {state.error ? <Alert tone="danger" title={state.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={pending}>
          {value.id ? "Save" : "Add feed"}
        </Button>
        {onDone ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            Close
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function FeedRowControls({ feed, accounts }: { feed: FeedValue & { id: string }; accounts: FeedAccount[] }) {
  const router = useProjectRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SocialAutomationState>({});
  if (editing) return <FeedForm value={feed} accounts={accounts} onDone={() => setEditing(false)} />;
  const run = (fn: () => Promise<SocialAutomationState>) =>
    start(async () => {
      setResult(await fn());
      router.refresh();
    });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={pending} onClick={() => run(() => runSocialFeedAction(feed.id))}>
          Check now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" loading={pending} onClick={() => (window.confirm("Delete this feed? Drafts it made are kept.") ? run(() => deleteSocialFeedAction(feed.id)) : undefined)}>
          Delete
        </Button>
      </div>
      {result.error ? <p className="text-xs text-[color:var(--color-danger)]">{result.error}</p> : null}
      {result.success ? <p className="text-xs text-[color:var(--color-success-fg)]">{result.success}</p> : null}
    </div>
  );
}
