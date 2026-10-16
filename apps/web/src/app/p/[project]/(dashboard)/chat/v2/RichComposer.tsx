"use client";

import { BarChart3, Loader2, MapPin, Paperclip, Plus, Sticker, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { locationMapUrl, parseCoordinates, POLL_LIMITS, validateLocation, validatePoll } from "@support-automation/shared";
import { Alert, Button, Checkbox, Dialog, Field, Input } from "@/components/ui";
import { useProjectHref } from "@/components/ProjectLink";
import { listStickerChoices, sendChatLocation, sendChatPoll, sendChatSticker, type StickerChoice } from "@/server/actions/chatRich";
import type { ConversationRef } from "@/server/chatThreadV2";

/**
 * The composer's attach menu (CHAT_RICH_MESSAGING.md §5): a poll (groups only — WhatsApp's own rule),
 * a location, or a sticker this project already holds. Each sends one queued message through the same
 * outbound queue as typed text; the browser checks the form for a friendly answer, the server and the
 * worker check it again.
 */

type Panel = "POLL" | "LOCATION" | "STICKER" | null;

export function RichComposer({ conversation, isGroup, onSent }: { conversation: ConversationRef; isGroup: boolean; onSent: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const open = (next: Panel) => {
    setMenuOpen(false);
    setPanel(next);
  };
  const done = () => {
    setPanel(null);
    onSent();
  };

  const item =
    "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-[13.5px] hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none active:bg-[var(--color-neutral-bg)] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Attach a poll, location or sticker"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="flex size-11 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:bg-[var(--color-neutral-bg)] sm:size-10 sm:rounded-[var(--radius-md)]"
      >
        <Paperclip className="size-4.5" aria-hidden />
      </button>
      {menuOpen ? (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)] animate-scale-in">
          <button type="button" role="menuitem" className={item} onClick={() => open("POLL")} disabled={!isGroup} title={isGroup ? undefined : "WhatsApp allows polls in groups only"}>
            <BarChart3 className="size-4 text-[color:var(--color-accent)]" aria-hidden />
            <span>
              Poll
              {!isGroup ? <span className="block text-[11px] text-[color:var(--color-muted-foreground)]">Groups only</span> : null}
            </span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => open("LOCATION")}>
            <MapPin className="size-4 text-[color:var(--color-danger)]" aria-hidden />
            Location
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => open("STICKER")}>
            <Sticker className="size-4 text-[color:var(--color-warning)]" aria-hidden />
            Sticker
          </button>
        </div>
      ) : null}

      {panel === "POLL" ? <PollDialog conversation={conversation} onClose={() => setPanel(null)} onSent={done} /> : null}
      {panel === "LOCATION" ? <LocationDialog conversation={conversation} onClose={() => setPanel(null)} onSent={done} /> : null}
      {panel === "STICKER" ? <StickerDialog conversation={conversation} onClose={() => setPanel(null)} onSent={done} /> : null}
    </div>
  );
}

function PollDialog({ conversation, onClose, onSent }: { conversation: ConversationRef; onClose: () => void; onSent: () => void }) {
  const [name, setName] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    // Empty trailing rows are the form's spare slots, not options the person meant.
    const filled = options.map((o) => o.trim()).filter(Boolean);
    const checked = validatePoll({ name, options: filled, allowMultiple });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setPending(true);
    const result = await sendChatPoll(conversation, checked.value);
    setPending(false);
    if (result.error) setError(result.error);
    else onSent();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send a poll"
      description="Goes to this group from the selected account, through the same queue and limits as a typed message."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Send poll
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="Question" htmlFor="poll-name" required>
          <Input id="poll-name" value={name} maxLength={POLL_LIMITS.nameMax} onChange={(e) => setName(e.target.value)} autoFocus dir="auto" />
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Options</legend>
          <div className="space-y-2">
            {options.map((option, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Option ${i + 1}`}
                  value={option}
                  maxLength={POLL_LIMITS.optionMax}
                  placeholder={`Option ${i + 1}`}
                  dir="auto"
                  onChange={(e) => setOptions((list) => list.map((o, j) => (j === i ? e.target.value : o)))}
                />
                {options.length > POLL_LIMITS.minOptions ? (
                  <button
                    type="button"
                    onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                    aria-label={`Remove option ${i + 1}`}
                    className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {options.length < POLL_LIMITS.maxOptions ? (
            <button type="button" onClick={() => setOptions((list) => [...list, ""])} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline">
              <Plus className="size-3.5" aria-hidden />
              Add an option
            </button>
          ) : null}
        </fieldset>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
          Allow more than one answer
        </label>
      </div>
    </Dialog>
  );
}

function LocationDialog({ conversation, onClose, onSent }: { conversation: ConversationRef; onClose: () => void; onSent: () => void }) {
  const [pasted, setPasted] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const preview = validateLocation({ latitude, longitude, name });

  function onPaste(value: string) {
    setPasted(value);
    const coords = parseCoordinates(value);
    if (coords) {
      setLatitude(String(coords.latitude));
      setLongitude(String(coords.longitude));
      setError(null);
    }
  }

  async function submit() {
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    setPending(true);
    const result = await sendChatLocation(conversation, preview.value);
    setPending(false);
    if (result.error) setError(result.error);
    else onSent();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Send a location"
      description="A pin on the map, sent from the selected account. Nothing reads your own location — type or paste the place."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            Send location
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field
          label="Paste coordinates or a map link"
          htmlFor="loc-paste"
          hint={pasted && !parseCoordinates(pasted) ? "No coordinates found in that. A short link (maps.app.goo.gl) carries none — open it and copy the full address bar instead." : 'For example "23.8103, 90.4125" or a Google Maps link.'}
        >
          <Input id="loc-paste" value={pasted} onChange={(e) => onPaste(e.target.value)} autoFocus inputMode="url" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Latitude" htmlFor="loc-lat" required>
            <Input id="loc-lat" value={latitude} onChange={(e) => setLatitude(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Longitude" htmlFor="loc-lng" required>
            <Input id="loc-lng" value={longitude} onChange={(e) => setLongitude(e.target.value)} inputMode="decimal" />
          </Field>
        </div>
        <Field label="Place name" htmlFor="loc-name" hint="Optional. Shown under the pin on WhatsApp.">
          <Input id="loc-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} dir="auto" />
        </Field>
        {preview.ok ? (
          <a
            href={locationMapUrl(preview.value.latitude, preview.value.longitude)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] hover:underline"
          >
            <MapPin className="size-3.5" aria-hidden />
            Check this place on a map
          </a>
        ) : null}
      </div>
    </Dialog>
  );
}

function StickerDialog({ conversation, onClose, onSent }: { conversation: ConversationRef; onClose: () => void; onSent: () => void }) {
  const toProject = useProjectHref();
  const [choices, setChoices] = useState<StickerChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listStickerChoices().then((list) => live && setChoices(list));
    return () => {
      live = false;
    };
  }, []);

  async function send(mediaId: string) {
    setSending(mediaId);
    const result = await sendChatSticker(conversation, mediaId);
    setSending(null);
    if (result.error) setError(result.error);
    else onSent();
  }

  return (
    <Dialog open onClose={onClose} title="Send a sticker" description="Stickers this project already received or sent, stored in media storage. Tap one to send it.">
      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {choices === null ? (
        <p className="flex items-center gap-2 text-[13px] text-[color:var(--color-muted-foreground)]">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading stickers…
        </p>
      ) : choices.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          No stored stickers yet. A sticker becomes available here once one has been received or sent in a conversation and media storage has saved it.
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {choices.map((choice) => (
            <button
              key={choice.mediaId}
              type="button"
              disabled={sending !== null}
              onClick={() => send(choice.mediaId)}
              aria-label={choice.animated ? "Send this animated sticker" : "Send this sticker"}
              className="relative flex aspect-square items-center justify-center rounded-[var(--radius-md)] border border-transparent p-1 hover:border-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:opacity-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a project-scoped media endpoint, not a static asset */}
              <img src={toProject(`/api/whatsapp/media/${encodeURIComponent(choice.mediaId)}`)} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
              {sending === choice.mediaId ? <Loader2 className="absolute size-5 animate-spin" aria-hidden /> : null}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
