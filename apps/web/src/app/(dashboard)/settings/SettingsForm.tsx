"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Checkbox, Field, Input, SectionHeader, SwitchField, useToast } from "@/components/ui";
import { updateSafetySettings, type SettingsFormState } from "@/server/actions/settings";
import type { AutomationSettings } from "@prisma/client";

export interface NotificationGroupOption {
  whatsappGroupId: string;
  name: string;
  isMonitored: boolean;
}

export function SettingsForm({
  settings,
  groups,
}: {
  settings: AutomationSettings;
  groups: NotificationGroupOption[];
}) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(updateSafetySettings, {});
  const { showToast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(settings.whatsappNotificationGroupIds),
  );
  const [groupSearch, setGroupSearch] = useState("");

  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, groupSearch]);

  const selectedGroups = useMemo(
    () => groups.filter((g) => selectedIds.has(g.whatsappGroupId)),
    [groups, selectedIds],
  );

  function toggleGroup(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (state.success) {
      showToast({ tone: "success", title: "Settings saved" });
    } else if (state.error) {
      showToast({ tone: "danger", title: "Could not save settings", description: state.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new action result arrives
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      <Card>
        <SectionHeader title="Per-Client Reply Limits" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Max replies per client per hour">
            <Input name="maxRepliesPerClientPerHour" type="number" defaultValue={settings.maxRepliesPerClientPerHour} />
          </Field>
          <Field label="Max replies per client per day">
            <Input name="maxRepliesPerClientPerDay" type="number" defaultValue={settings.maxRepliesPerClientPerDay} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Global Rate Limiting" />
        <SwitchField
          className="mb-4"
          name="rateLimitingEnabled"
          label="Rate limiting enabled"
          defaultChecked={settings.rateLimitingEnabled}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Max per minute">
            <Input name="globalMaxPerMinute" type="number" defaultValue={settings.globalMaxPerMinute} />
          </Field>
          <Field label="Max per hour">
            <Input name="globalMaxPerHour" type="number" defaultValue={settings.globalMaxPerHour} />
          </Field>
          <Field label="Max per day">
            <Input name="globalMaxPerDay" type="number" defaultValue={settings.globalMaxPerDay} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Reply Delay & Retries" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Default delay min (ms)">
            <Input name="defaultReplyDelayMinMs" type="number" defaultValue={settings.defaultReplyDelayMinMs} />
          </Field>
          <Field label="Default delay max (ms)">
            <Input name="defaultReplyDelayMaxMs" type="number" defaultValue={settings.defaultReplyDelayMaxMs} />
          </Field>
          <Field label="Max retry attempts">
            <Input name="retryMaxAttempts" type="number" defaultValue={settings.retryMaxAttempts} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Notification Destinations" />
        <Field label="Microsoft Teams webhook URL">
          <Input name="teamsWebhookUrl" defaultValue={settings.teamsWebhookUrl ?? ""} />
        </Field>
        <div className="mt-4">
          <Field
            label="WhatsApp support group(s)"
            hint="Optional. Select one or more synchronized groups to receive automation alerts."
          >
            {[...selectedIds].map((id) => (
              <input key={id} type="hidden" name="whatsappNotificationGroupIds" value={id} />
            ))}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Input
                placeholder="Search groups by name…"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                className="max-w-sm"
              />
              <span className="text-xs text-[color:var(--color-muted-foreground)]">
                {selectedIds.size} selected
              </span>
              {selectedIds.size > 0 ? (
                <button
                  type="button"
                  className="cursor-pointer text-xs underline text-[color:var(--color-muted-foreground)]"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)]">
              {filteredGroups.length === 0 ? (
                <p className="p-4 text-sm text-[color:var(--color-muted-foreground)]">No groups match your search.</p>
              ) : (
                filteredGroups.map((g) => (
                  <label
                    key={g.whatsappGroupId}
                    className="flex cursor-pointer items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--color-neutral-bg)]"
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedIds.has(g.whatsappGroupId)}
                        onChange={() => toggleGroup(g.whatsappGroupId)}
                      />
                      {g.name}
                    </span>
                    {g.isMonitored ? <Badge color="yellow">Monitored — avoid using as a target</Badge> : null}
                  </label>
                ))
              )}
            </div>
            {selectedGroups.some((g) => g.isMonitored) ? (
              <div className="mt-2">
                <Alert tone="danger" title="Feedback-loop risk">
                  One or more selected groups are also monitored as a client conversation — alerts sent there
                  will be re-ingested as incoming messages. Prefer a dedicated internal group.
                </Alert>
              </div>
            ) : null}
          </Field>
        </div>
      </Card>

      <Button type="submit" loading={pending}>
        Save Settings
      </Button>
    </form>
  );
}
