"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useState, useTransition } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  GroupPicker,
  SectionHeader,
  SwitchField,
  type PickableGroup,
} from "@/components/ui";
import { updateNotificationEvent } from "@/server/actions/notificationEvents";

export interface NotificationEventCardProps {
  event: string;
  copy: { title: string; description: string; consequence: string };
  sentCount: number;
  groups: PickableGroup[];
  globalGroupCount: number;
  setting: {
    enabled: boolean;
    sendToTeams: boolean;
    sendToWhatsApp: boolean;
    whatsappGroupIds: string[];
  };
}

/**
 * One event's card. Collapsed to a summary until someone opens it, because the common visit is
 * "which of these is making all the noise" — a page of five expanded forms answers that far worse
 * than five one-line summaries.
 */
export function NotificationEventCard({
  event,
  copy,
  sentCount,
  groups,
  globalGroupCount,
  setting,
}: NotificationEventCardProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, startSaving] = useTransition();

  // What was SAVED, not what is currently ticked — the picker below owns and displays live
  // selection state, and two live counters describing one thing is how they end up disagreeing.
  const usesGlobal = setting.whatsappGroupIds.length === 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-medium text-[color:var(--color-foreground)]">{copy.title}</h3>
            {setting.enabled ? (
              <Badge color="green" dot>
                On
              </Badge>
            ) : (
              <Badge color="yellow" dot>
                Muted
              </Badge>
            )}
            {sentCount > 0 ? (
              <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
                {sentCount.toLocaleString()} sent
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            {copy.description}
          </p>
        </div>

        <Button variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Configure"}
        </Button>
      </div>

      {open ? (
        <form
          action={(formData) =>
            startSaving(async () => {
              await updateNotificationEvent(formData);
              setOpen(false);
              router.refresh();
            })
          }
          className="mt-5 space-y-4 border-t border-[var(--color-border)] pt-5"
        >
          <input type="hidden" name="event" value={event} />

          {/* The consequence of muting, said plainly and next to the switch that does it. */}
          <Alert tone={setting.enabled ? "info" : "warning"}>{copy.consequence}</Alert>

          <div className="space-y-2.5">
            <SwitchField
              name="enabled"
              defaultChecked={setting.enabled}
              label="Raise this alert"
              description="Off means nothing is written and nothing is delivered — not delayed, not queued."
            />
            <SwitchField
              name="sendToWhatsApp"
              defaultChecked={setting.sendToWhatsApp}
              label="Send to WhatsApp"
              description="To the groups chosen below, or the global notification groups if none are."
            />
            <SwitchField
              name="sendToTeams"
              defaultChecked={setting.sendToTeams}
              label="Send to Microsoft Teams"
              description="Uses the Teams webhook from Settings."
            />
          </div>

          <div>
            <SectionHeader
              title="WhatsApp groups for this alert"
              description={
                usesGlobal
                  ? `Currently none chosen, so this uses the ${globalGroupCount} global notification group${globalGroupCount === 1 ? "" : "s"}.`
                  : `Currently set to ${setting.whatsappGroupIds.length} group${setting.whatsappGroupIds.length === 1 ? "" : "s"}. This alert goes only to those.`
              }
            />
            {/* The shared searchable picker, rather than a raw checkbox list of the first 300
                groups alphabetically — which on 1,848 groups made any destination past the letter M
                literally unselectable. It also carries the feedback-loop warning, which matters more
                here than anywhere: alerting into a monitored group re-ingests the alert as a
                customer message. */}
            <GroupPicker
              name="whatsappGroupIds"
              groups={groups}
              defaultSelected={setting.whatsappGroupIds}
              emptyMeaning="Nothing chosen, so this alert uses the global notification groups."
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
