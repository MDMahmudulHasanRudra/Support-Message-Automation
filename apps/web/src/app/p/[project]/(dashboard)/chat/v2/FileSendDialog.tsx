"use client";

import { FileAudio, FileText, Film, ImageIcon, Mic, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OUTGOING_CAPTION_MAX, planOutgoingFile, type OutgoingFileKind, type OutgoingFileMode, type OutgoingFilePlan } from "@support-automation/shared";
import { Alert, Button, Checkbox, Dialog, Field, Textarea } from "@/components/ui";
import { useProjectHref } from "@/components/ProjectLink";
import type { ConversationRef } from "@/server/chatThreadV2";

/**
 * Sending photos, videos, audio, voice notes and documents from WhatsApp Chat (CHAT_FILE_SENDING.md).
 *
 * The browser reads each file's first bytes with the same rule the server uses (`planOutgoingFile`), so
 * a refused file says why before anything is uploaded — the server and the worker still decide. Each
 * file is its own upload and its own queued message, one after another, with its own upload id: a
 * retried request can never send it twice. Nothing is sent until "Send" is pressed.
 */

export const MAX_FILES_PER_SEND = 10;

interface Item {
  id: string;
  file: File;
  plan: OutgoingFilePlan | null;
  /** Object URL for a photo or video preview, revoked when the item goes. */
  preview: string | null;
  /** The natural kind (photo / video / voice-capable audio), before the person's choice. */
  natural: OutgoingFileKind | null;
  canVoice: boolean;
  status: "READY" | "SENDING" | "SENT" | "FAILED";
  progress: number;
  error: string | null;
}

const KIND_ICON: Record<OutgoingFileKind, typeof ImageIcon> = { IMAGE: ImageIcon, VIDEO: Film, AUDIO: FileAudio, VOICE: Mic, DOCUMENT: FileText };
const KIND_LABEL: Record<OutgoingFileKind, string> = { IMAGE: "Photo", VIDEO: "Video", AUDIO: "Audio", VOICE: "Voice note", DOCUMENT: "Document" };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function examine(file: File, mode: OutgoingFileMode): Promise<{ plan: OutgoingFilePlan; natural: OutgoingFileKind | null; canVoice: boolean }> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const natural = planOutgoingFile({ head, fileName: file.name, size: file.size, mode: "AUTO" });
  const voice = planOutgoingFile({ head, fileName: file.name, size: file.size, mode: "VOICE" });
  const plan = mode === "AUTO" ? natural : planOutgoingFile({ head, fileName: file.name, size: file.size, mode });
  return { plan, natural: natural.ok ? natural.kind : null, canVoice: voice.ok };
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** One upload, with progress. Resolves to the server's sentence on a refusal. */
function upload(url: string, form: FormData, onProgress: (fraction: number) => void): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    xhr.onload = () => {
      const body = xhr.response as { ok?: boolean; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok) resolve({ ok: true });
      else if (xhr.status === 413) resolve({ ok: false, error: body?.error ?? "The file is too large to send." });
      else resolve({ ok: false, error: body?.error ?? `The server refused the file (${xhr.status}). Nothing was sent.` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "The connection dropped during the upload. Nothing was sent — try again." });
    xhr.ontimeout = () => resolve({ ok: false, error: "The upload took too long. Nothing was sent — try again." });
    xhr.timeout = 5 * 60_000;
    xhr.send(form);
  });
}

export function FileSendDialog({
  conversation,
  files,
  startAsDocument,
  onClose,
  onSent,
}: {
  conversation: ConversationRef;
  files: File[];
  /** Opened from "Document": every file goes as a file, with no preview. */
  startAsDocument: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const toProject = useProjectHref();
  const [items, setItems] = useState<Item[]>([]);
  const [asDocument, setAsDocument] = useState(startAsDocument);
  const [asVoice, setAsVoice] = useState(false);
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    files.length > MAX_FILES_PER_SEND ? `Only the first ${MAX_FILES_PER_SEND} files were added. Send the rest in another batch.` : null,
  );

  const mode: OutgoingFileMode = asDocument ? "DOCUMENT" : asVoice ? "VOICE" : "AUTO";

  // Read every file's first bytes again whenever the way of sending changes.
  useEffect(() => {
    let live = true;
    const chosen = files.slice(0, MAX_FILES_PER_SEND);
    void Promise.all(chosen.map((file) => examine(file, mode))).then((results) => {
      if (!live) return;
      setItems((previous) =>
        chosen.map((file, i) => {
          const old = previous[i];
          const { plan, natural, canVoice } = results[i]!;
          const showsPreview = natural === "IMAGE" || natural === "VIDEO";
          return {
            id: old?.id ?? newId(),
            file,
            plan,
            preview: old?.preview ?? (showsPreview ? URL.createObjectURL(file) : null),
            natural,
            canVoice,
            status: old?.status ?? "READY",
            progress: old?.progress ?? 0,
            error: old?.error ?? null,
          };
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [files, mode]);

  // Previews are released when the dialog goes.
  useEffect(() => () => items.forEach((item) => item.preview && URL.revokeObjectURL(item.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = items.filter((item) => item.status !== "SENT");
  const sendable = remaining.filter((item) => item.plan?.ok);
  const hasMedia = items.some((item) => item.natural === "IMAGE" || item.natural === "VIDEO");
  const voiceAvailable = items.length === 1 && items[0]!.canVoice && !asDocument;
  const refused = useMemo(() => remaining.filter((item) => item.plan && !item.plan.ok).length, [remaining]);

  function remove(id: string) {
    setItems((list) => {
      const gone = list.find((item) => item.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return list.filter((item) => item.id !== id);
    });
  }

  const patch = (id: string, change: Partial<Item>) => setItems((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  async function send() {
    setSending(true);
    setNotice(null);
    let failures = 0;
    let first = true;
    for (const item of sendable) {
      patch(item.id, { status: "SENDING", progress: 0, error: null });
      const form = new FormData();
      form.set("file", item.file, item.file.name);
      form.set("uploadId", item.id);
      form.set("mode", mode);
      // The caption goes with the first file, as on a phone.
      if (first && caption.trim() && !asVoice) form.set("caption", caption.trim());
      form.set("accountId", conversation.accountId);
      if (conversation.groupId) form.set("groupId", conversation.groupId);
      if (conversation.personalChatId) form.set("personalChatId", conversation.personalChatId);
      const result = await upload(toProject("/api/whatsapp/send-file"), form, (progress) => patch(item.id, { progress }));
      if (result.ok) {
        patch(item.id, { status: "SENT", progress: 1 });
        if (first) setCaption("");
        first = false;
      } else {
        failures += 1;
        // A failed file keeps its id, so pressing Send again cannot duplicate one that did arrive.
        patch(item.id, { status: "FAILED", error: result.error });
      }
    }
    setSending(false);
    if (failures === 0) {
      onSent();
      return;
    }
    setNotice(`${failures} of ${sendable.length} ${sendable.length === 1 ? "file was" : "files were"} not sent. Fix or remove ${failures === 1 ? "it" : "them"} and press Send again.`);
  }

  const title = items.length > 1 ? `Send ${items.length} files` : items[0] ? `Send ${KIND_LABEL[items[0].plan?.ok ? items[0].plan.kind : "DOCUMENT"].toLowerCase()}` : "Send a file";

  return (
    <Dialog
      open
      onClose={sending ? () => undefined : onClose}
      title={title}
      description="Sent from the selected account through the same queue and limits as a typed message. Nothing goes until you press Send."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} loading={sending} disabled={sendable.length === 0}>
            {sendable.length > 1 ? `Send ${sendable.length} files` : "Send"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {notice ? <Alert tone="warning">{notice}</Alert> : null}
        {refused > 0 && !sending ? <Alert tone="danger">{refused === 1 ? "One file cannot be sent — see the reason below." : `${refused} files cannot be sent — see the reasons below.`}</Alert> : null}

        <ul className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
          {items.map((item) => {
            const kind: OutgoingFileKind = item.plan?.ok ? item.plan.kind : (item.natural ?? "DOCUMENT");
            const Icon = KIND_ICON[kind];
            const showPreview = item.preview && !asDocument;
            return (
              <li key={item.id} className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-neutral-bg)]">
                  {showPreview && item.natural === "IMAGE" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a local object URL, never uploaded until Send
                    <img src={item.preview!} alt="" className="size-full object-cover" />
                  ) : showPreview && item.natural === "VIDEO" ? (
                    <video src={item.preview!} className="size-full object-cover" muted playsInline preload="metadata" />
                  ) : (
                    <Icon className="size-6 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium" title={item.file.name}>
                    {item.plan?.ok ? item.plan.fileName : item.file.name}
                  </p>
                  <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                    {KIND_LABEL[kind]} · {formatSize(item.file.size)}
                    {item.status === "SENT" ? " · Queued to send" : null}
                  </p>
                  {item.plan && !item.plan.ok ? <p className="mt-1 text-[12px] text-[color:var(--color-danger-fg)]">{item.plan.error}</p> : null}
                  {item.error ? <p className="mt-1 text-[12px] text-[color:var(--color-danger-fg)]">{item.error}</p> : null}
                  {item.status === "SENDING" ? (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)} aria-label={`Uploading ${item.file.name}`}>
                      <div className="h-full bg-[var(--wa-green,var(--color-accent))] transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                {item.status !== "SENDING" && item.status !== "SENT" && !sending ? (
                  <button
                    type="button"
                    onClick={() => remove(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {!asVoice ? (
          <Field label="Caption" htmlFor="file-caption" hint={items.length > 1 ? "Optional. Goes with the first file, as on a phone." : "Optional."}>
            <Textarea id="file-caption" value={caption} rows={2} maxLength={OUTGOING_CAPTION_MAX} onChange={(e) => setCaption(e.target.value)} dir="auto" disabled={sending} />
          </Field>
        ) : null}

        <div className="space-y-2">
          {hasMedia || asDocument ? (
            <label className="flex items-start gap-2 text-[13px]">
              <Checkbox checked={asDocument} onChange={(e) => setAsDocument(e.target.checked)} disabled={sending} />
              <span>
                Send as a document
                <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">Keeps photos and videos at full quality, with no preview in the chat.</span>
              </span>
            </label>
          ) : null}
          {voiceAvailable || asVoice ? (
            <label className="flex items-start gap-2 text-[13px]">
              <Checkbox checked={asVoice} onChange={(e) => setAsVoice(e.target.checked)} disabled={sending} />
              <span>
                Send as a voice note
                <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">Shows as a recorded voice message. Voice notes carry no caption.</span>
              </span>
            </label>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
