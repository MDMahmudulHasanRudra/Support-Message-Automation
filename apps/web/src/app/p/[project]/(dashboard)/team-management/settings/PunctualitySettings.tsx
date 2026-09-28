"use client";

import { useTransition } from "react";
import { Button, Card, Field, Input, SectionHeader, useToast } from "@/components/ui";
import { saveTeamManagementSettings } from "@/server/actions/teamManagement";

/**
 * How much lateness this organisation calls on time.
 *
 * Duty History compares each day's snapshotted shift times against the first and last message
 * actually stored from that person — arithmetic that needs no setting. What needs one is the policy
 * laid over it, and this module's rule is that a business rule never lives in the source. The three
 * shift templates are seed rows for the same reason: 10:00–19:00 is a decision somebody made.
 *
 * Two fields rather than one, unlike the single presence threshold Support Activity shares between
 * its two readings: arriving late and leaving early are judged differently by most teams, and one
 * shared tolerance would force one of the two to be wrong.
 */
export function PunctualitySettings({
  latenessGraceMinutes,
  earlyDepartureGraceMinutes,
}: {
  latenessGraceMinutes: number;
  earlyDepartureGraceMinutes: number;
}) {
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();

  return (
    <Card>
      <SectionHeader
        title="Punctuality"
        description="Duty History flags a late start or an early finish only once these are exceeded. A smaller overrun is still shown on the row — it is simply not called late."
      />
      <form
        action={(formData) =>
          startTransition(async () => {
            const result = await saveTeamManagementSettings(formData);
            if (result.error) showToast({ tone: "danger", title: result.error });
            else if (result.updated)
              showToast({
                tone: "success",
                title: "Punctuality saved",
                // Said out loud because the opposite is the natural assumption: this is a reading
                // applied at display time, so it re-reads history rather than only future days.
                description: "Duty history is re-read against the new grace, including past days.",
              });
            else showToast({ tone: "info", title: "No change — those values were already saved" });
          })
        }
        className="flex flex-wrap items-end gap-4"
      >
        <Field label="Late start grace (minutes)">
          <Input
            name="latenessGraceMinutes"
            type="number"
            min={0}
            max={1440}
            defaultValue={latenessGraceMinutes}
            className="w-40"
          />
        </Field>
        <Field label="Early finish grace (minutes)">
          <Input
            name="earlyDepartureGraceMinutes"
            type="number"
            min={0}
            max={1440}
            defaultValue={earlyDepartureGraceMinutes}
            className="w-40"
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
      <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
        A last message is the last message, not the moment somebody stopped working — read the early
        finish figure as a prompt to ask, never as a conclusion.
      </p>
    </Card>
  );
}
