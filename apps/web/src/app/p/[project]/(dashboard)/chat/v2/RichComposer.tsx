"use client";

import { BarChart3, FileAudio, FileText, ImageIcon, Loader2, MapPin, Paperclip, Plus, Sticker, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { locationMapUrl, parseCoordinates, POLL_LIMITS, validateLocation, validatePoll } from "@support-automation/shared";
import { Alert, Button, Checkbox, Dialog, Field, Input } from "@/components/ui";
import { useProjectHref } from "@/components/ProjectLink";
import { listStickerChoices, sendChatLocation, sendChatPoll, sendChatSticker, type StickerChoice } from "@/server/actions/chatRich";
import type { ConversationRef } from "@/server/chatThreadV2";
import { FileSendDialog } from "./FileSendDialog";

/**
 * The composer's attach menu (CHAT_RICH_MESSAGING.md §5): photos and videos, documents and audio
 * (CHAT_FILE_SENDING.md — also by pasting or dropping a file onto the conversation), a poll (groups only —
 * WhatsApp's own rule), a location, or a sticker this project already holds. Each sends one queued message through the same
 * outbound queue as typed text; the browser checks the form for a friendly answer, the server and the
 * worker check it again.
 */

type Panel = "POLL" | "LOCATION" | "STICKER" | null;

export function RichComposer({ conversation, isGroup, onSent }: { conversation: ConversationRef; isGroup: boolean; onSent: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [files, setFiles] = useState<{ list: File[]; asDocument: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const chooseFiles = (list: FileList | File[] | null, asDocument: boolean) => {
    const chosen = list ? Array.from(list) : [];
    if (chosen.length) {
      setPanel(null);
      setFiles({ list: chosen, asDocument });
    }
  };

  // A file pasted into the message box, or dropped anywhere on the conversation, opens the same
  // dialog — never sends by itself. Text pastes and drags of anything but files are left alone.
  useEffect(() => {
    const busy = () => files !== null || panel !== null;
    const onPaste = (event: ClipboardEvent) => {
      if (busy() || (document.activeElement as HTMLElement | null)?.id !== "chat-body-v2") return;
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (!pasted.length) return;
      event.preventDefault();
      chooseFiles(pasted, false);
    };
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (event: DragEvent) => {
      if (busy() || !hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      setDragging(false);
      if (busy() || !hasFiles(event)) return;
      event.preventDefault();
      chooseFiles(event.dataTransfer?.files ?? null, false);
    };
    document.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [files, panel]);

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
    setFiles(null);
    onSent();
  };
  const pick = (input: HTMLInputElement | null) => {
    setMenuOpen(false);
    if (input) {
      input.value = "";
      input.click();
    }
  };

  const item =
    "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-[13.5px] hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none active:bg-[var(--color-neutral-bg)] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Attach a photo, video, document, audio, poll, location or sticker"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="flex size-11 items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] active:bg-[var(--color-neutral-bg)] sm:size-11 sm:border sm:border-[var(--color-border)] sm:bg-[var(--color-surface)] sm:hover:border-[var(--color-border-strong)]"
      >
        <Paperclip className="size-4.5" aria-hidden />
      </button>
      {menuOpen ? (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)] animate-scale-in">
          <button type="button" role="menuitem" className={item} onClick={() => pick(mediaInput.current)}>
            <ImageIcon className="size-4 text-[color:var(--color-accent)]" aria-hidden />
            Photos &amp; videos
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick(documentInput.current)}>
            <FileText className="size-4 text-[color:var(--color-info,var(--color-accent))]" aria-hidden />
            Document
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick(audioInput.current)}>
            <FileAudio className="size-4 text-[color:var(--color-success)]" aria-hidden />
            Audio
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" role="separator" />
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

      {/* Hidden pickers: the browser's own file chooser, filtered to what can be sent. */}
      <input ref={mediaInput} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,video/quicktime" onChange={(e) => chooseFiles(e.target.files, false)} />
      <input
        ref={documentInput}
        type="file"
        multiple
        hidden
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.rtf,.zip,image/*,video/mp4,audio/*"
        onChange={(e) => chooseFiles(e.target.files, true)}
      />
      <input ref={audioInput} type="file" multiple hidden accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,audio/opus,audio/wav,.mp3,.m4a,.ogg,.opus,.wav" onChange={(e) => chooseFiles(e.target.files, false)} />

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--color-background)]/70 backdrop-blur-[1px]">
          <p className="rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--color-accent)] bg-[var(--color-surface-raised)] px-6 py-4 text-[14px] font-medium shadow-[var(--shadow-lg)]">
            Drop to choose files to send — nothing goes until you press Send
          </p>
        </div>
      ) : null}

      {files ? <FileSendDialog conversation={conversation} files={files.list} startAsDocument={files.asDocument} onClose={() => setFiles(null)} onSent={done} /> : null}
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
