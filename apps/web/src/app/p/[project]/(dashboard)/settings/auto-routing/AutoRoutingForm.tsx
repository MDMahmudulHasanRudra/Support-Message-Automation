"use client";

import { useState, useTransition } from "react";
import { Button, Checkbox, Field, Input, Select, SwitchField, useToast } from "@/components/ui";
import { saveAutoRoutingSettings } from "@/server/actions/autoRouting";
import {
  ROUTING_CAPACITY_MAX,
  ROUTING_CAPACITY_MIN,
  ROUTING_CHANNEL_LABELS,
  ROUTING_CHANNELS,
  ROUTING_METHOD_LABELS,
  ROUTING_METHODS,
  ROUTING_SEEN_MAX_MINUTES,
  ROUTING_SEEN_MIN_MINUTES,
  type RoutingChannel,
  type RoutingMethod,
  type RoutingSettingsValue,
} from "@support-automation/shared";

type Option = { id: string; name: string };

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
}

export function AutoRoutingForm({ initial, teams, people, canManage }: { initial: RoutingSettingsValue; teams: Option[]; people: Option[]; canManage: boolean }) {
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  const [value, setValue] = useState<RoutingSettingsValue>(initial);
  const set = (patch: Partial<RoutingSettingsValue>) => setValue((v) => ({ ...v, ...patch }));
  const off = !canManage || busy;
  // A chosen person who is no longer offered (access removed) stays visible, so saving never drops them silently.
  const peopleShown = [...people, ...value.poolUserIds.filter((id) => !people.some((p) => p.id === id)).map((id) => ({ id, name: "Someone without access any more" }))];

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveAutoRoutingSettings(value);
          showToast("error" in r ? { tone: "danger", title: "Nothing was saved", description: r.error } : { tone: "success", title: "Saved" });
        });
      }}
    >
      <SwitchField
        label="Route new conversations automatically"
        description="Off: nobody is assigned by routing. Assignments already made stay as they are."
        checked={value.enabled}
        disabled={off}
        onChange={(e) => set({ enabled: e.target.checked })}
      />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Which conversations</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROUTING_CHANNELS.map((c: RoutingChannel) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.channels.includes(c)} disabled={off} onChange={(e) => set({ channels: toggle(value.channels, c, e.target.checked) as RoutingChannel[] })} />
              {ROUTING_CHANNEL_LABELS[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <SwitchField
        label="Also WhatsApp groups without an owner"
        description="A group's owner is set on the Groups page; a group that has one is never routed. Off by default."
        checked={value.includeWhatsAppGroups}
        disabled={off}
        onChange={(e) => set({ includeWhatsAppGroups: e.target.checked })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How">
          <Select value={value.method} disabled={off} onChange={(e) => set({ method: e.target.value as RoutingMethod })}>
            {ROUTING_METHODS.map((m) => (
              <option key={m} value={m}>
                {ROUTING_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Most open conversations per person" hint="Open and Pending conversations someone holds. At the limit, routing passes them by.">
          <Input
            type="number"
            min={ROUTING_CAPACITY_MIN}
            max={ROUTING_CAPACITY_MAX}
            value={value.maxOpenPerAgent}
            disabled={off}
            onChange={(e) => set({ maxOpenPerAgent: Number(e.target.value) })}
          />
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Who — Teams</legend>
        {teams.length === 0 ? <p className="text-xs text-[color:var(--color-muted-foreground)]">No Teams yet.</p> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {teams.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.poolTeamIds.includes(t.id)} disabled={off} onChange={(e) => set({ poolTeamIds: toggle(value.poolTeamIds, t.id, e.target.checked) })} />
              {t.name}
            </label>
          ))}
        </div>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">A Team counts its members at the moment of routing — only members linked to a login.</p>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Who — people</legend>
        <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
          {peopleShown.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={value.poolUserIds.includes(p.id)} disabled={off} onChange={(e) => set({ poolUserIds: toggle(value.poolUserIds, p.id, e.target.checked) })} />
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>

      <SwitchField
        label="Only people on duty now"
        description="By the roster: a working shift that covers this moment, not on leave, not marked absent. People not linked to a team member are left out. Approved leave always leaves someone out, whatever this says."
        checked={value.onlyOnDuty}
        disabled={off}
        onChange={(e) => set({ onlyOnDuty: e.target.checked })}
      />
      <SwitchField
        label="Only people seen in the dashboard recently"
        description="Their sign-in was used within the minutes below. The dashboard notes this at most every five minutes."
        checked={value.requireRecentlySeen}
        disabled={off}
        onChange={(e) => set({ requireRecentlySeen: e.target.checked })}
      />
      {value.requireRecentlySeen ? (
        <Field label="Seen within (minutes)">
          <Input
            type="number"
            min={ROUTING_SEEN_MIN_MINUTES}
            max={ROUTING_SEEN_MAX_MINUTES}
            value={value.recentlySeenMinutes}
            disabled={off}
            onChange={(e) => set({ recentlySeenMinutes: Number(e.target.value) })}
          />
        </Field>
      ) : null}

      {canManage ? (
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      ) : null}
    </form>
  );
}
