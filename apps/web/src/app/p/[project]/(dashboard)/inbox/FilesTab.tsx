"use client";

import { useEffect, useState } from "react";
import { FileText, Film, Image as ImageIcon, Music, Paperclip } from "lucide-react";
import type { ConversationRef } from "@support-automation/shared";
import { readConversationFiles } from "@/server/actions/inboxWorkspace";
import type { ConversationFile } from "@/server/conversationFiles";

const ICONS = { IMAGE: ImageIcon, VIDEO: Film, AUDIO: Music, DOCUMENT: FileText, OTHER: Paperclip } as const;
const KIND_LABEL = { IMAGE: "Photo", VIDEO: "Video", AUDIO: "Audio", DOCUMENT: "Document", OTHER: "File" } as const;

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric" });

/** Every attachment of this conversation, newest first (INBOX_WORKSPACE.md §Files). Loaded only when the tab is opened. */
export function FilesTab({ conversation }: { conversation: ConversationRef }) {
  const [state, setState] = useState<{ files: ConversationFile[]; error: string | null } | null>(null);
  const key = JSON.stringify(conversation);

  useEffect(() => {
    let cancelled = false;
    readConversationFiles(JSON.parse(key))
      .then((result) => {
        if (cancelled) return;
        setState("error" in result ? { files: [], error: result.error } : { files: result.files, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ files: [], error: "The files could not be loaded. Try again." });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!state) return <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">Loading files…</p>;
  if (state.error) return <p className="text-[12.5px] text-[color:var(--color-danger-fg)]">{state.error}</p>;
  if (state.files.length === 0) return <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">No files in this conversation yet.</p>;

  return (
    <ul className="space-y-1">
      {state.files.map((f) => {
        const Icon = ICONS[f.kind];
        const size = formatSize(f.sizeBytes);
        const meta = [DATE.format(new Date(f.at)), size, f.note].filter(Boolean).join(" · ");
        const body = (
          <>
            <Icon className="mt-0.5 size-4 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-[color:var(--color-foreground)]">{f.name ?? KIND_LABEL[f.kind]}</span>
              <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">{meta}</span>
            </span>
          </>
        );
        return (
          <li key={f.id}>
            {f.href ? (
              <a href={f.href} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 rounded-[var(--radius-sm)] px-1.5 py-1.5 hover:bg-[var(--color-neutral-bg)]">
                {body}
              </a>
            ) : (
              <div className="flex items-start gap-2 px-1.5 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
