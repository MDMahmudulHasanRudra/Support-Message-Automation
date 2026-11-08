"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CONTACT_CAMPAIGN_CHANNEL_LABEL, CONTACT_CAMPAIGN_CHANNELS, CONTACT_SOURCE_LABEL, CONTACT_SOURCES, renderContactCampaignText, type ContactCampaignChannelValue } from "@support-automation/shared";
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { createContactCampaign, previewCampaignAudience } from "@/server/actions/contacts";

type Audience = { reachable: number; total: number; skipped: Array<{ reason: string; count: number }> };
type Selection = { ids: string[] } | { filters: Record<string, unknown> };

/**
 * Starts a campaign, from people ticked on the list or from a tag or source chosen here. Email goes out through the
 * project's mail server. Every other channel becomes a list worked through one person at a time, because automatic cold
 * messages are how a WhatsApp number gets banned.
 */
export function NewCampaignDialog({ open, onClose, selection, count, knownTags }: { open: boolean; onClose: () => void; selection: Selection | null; count: number | null; knownTags: string[] }) {
  const router = useProjectRouter();
  const [channel, setChannel] = useState<ContactCampaignChannelValue>("WHATSAPP");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("Hello {{first_name}}, ");
  const [touchedConsent, setTouchedConsent] = useState(false);
  const [unknownTicked, setUnknownTicked] = useState(true);
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A person's own message on a list is one thing; a mass email to people never asked is another, so the default differs.
  const includeUnknown = touchedConsent ? unknownTicked : channel !== "EMAIL";
  const chosen = useMemo<Selection>(() => selection ?? { filters: { tag, source } }, [selection, tag, source]);

  useEffect(() => {
    let live = true;
    void previewCampaignAudience({ selection: chosen, channel, includeUnknown }).then((r) => {
      if (live && !("error" in r)) setAudience(r);
    });
    return () => {
      live = false;
    };
  }, [chosen, channel, includeUnknown]);

  const preview = renderContactCampaignText(body, { name: "Nusrat Jahan", company: "Bizify", serial: 12 });

  const submit = () =>
    start(async () => {
      const result = await createContactCampaign({ name, channel, subject, body, includeUnknown, selection: chosen });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(`/contacts/campaigns/${result.id}`);
    });

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="New campaign" description={count !== null ? `For the ${count.toLocaleString("en-US")} contacts you selected.` : "Offers, reminders and wake-up calls."}>
      <div className="space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="For example: Eid offer" />
          </Field>
          <Field label="How">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as ContactCampaignChannelValue)}>
              {CONTACT_CAMPAIGN_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CONTACT_CAMPAIGN_CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {selection === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who: tag">
              <Select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Everyone</option>
                {knownTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Who: came from">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Anywhere</option>
                {CONTACT_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {CONTACT_SOURCE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}

        {channel === "EMAIL" ? (
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </Field>
        ) : null}
        <Field label={channel === "CALL" ? "What to say" : "Message"} hint="{{name}}, {{first_name}}, {{company}} and {{serial}} are filled in for each person.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000} />
        </Field>
        {body.trim() ? (
          <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[13px]">
            <p className="mb-0.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">How it reads</p>
            <p className="whitespace-pre-wrap">{preview}</p>
          </div>
        ) : null}

        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox
            checked={includeUnknown}
            onChange={(e) => {
              setTouchedConsent(true);
              setUnknownTicked(e.target.checked);
            }}
          />
          Include people who have not been asked about offers
        </label>

        {audience ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-[13px]">
            <p className="font-semibold">
              <span className="tabular">{audience.reachable.toLocaleString("en-US")}</span> of <span className="tabular">{audience.total.toLocaleString("en-US")}</span> can be reached this way
            </p>
            {audience.skipped.map((s) => (
              <p key={s.reason} className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                {s.count.toLocaleString("en-US")} left out: {s.reason.toLowerCase()}
              </p>
            ))}
          </div>
        ) : null}

        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
          {channel === "EMAIL"
            ? "Goes out through your mail server, at its own pace, after you press Start. Each email has a line telling people how to stop."
            : "You will go through the list one person at a time and press send yourself. Automatic messages to people who did not write first are how a number gets banned."}
        </p>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Creating…" : "Create campaign"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
