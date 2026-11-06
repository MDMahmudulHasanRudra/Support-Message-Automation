"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Loader2, Lock, MessageSquareText, Sparkles, StickyNote } from "lucide-react";
import { useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { fillComposer } from "@/lib/composerBridge";
import { addConversationNote, markCopilotDraftUsed, readCopilotDrafts, requestCopilot } from "@/server/actions/inboxWorkspace";
import { openPanel, useWorkspaceInfo } from "./panelStore";

/**
 * Reply / Note / AI draft above any reply box. The reply box itself is passed in and stays mounted while a
 * note is being written, so an unsent reply is never lost. A note goes through the same action as the Notes
 * tab; an AI draft through the same Copilot request, and it only ever fills the box. Sending stays the
 * person's own press.
 */
export function ComposerShell({ children }: { children: ReactNode }) {
  const info = useWorkspaceInfo();
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [note, setNote] = useState("");
  const [saving, startSaving] = useTransition();
  const [drafting, setDrafting] = useState(false);
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const canNote = Boolean(info?.access.collaboration && info.access.canWrite);
  const canDraft = Boolean(info?.access.copilot && info.access.canWrite);
  const noteCount = info?.notes.length ?? 0;
  const lastNote = noteCount ? info!.notes[noteCount - 1]! : null;

  const saveNote = () => {
    const body = note.trim();
    if (!info || !body || saving) return;
    startSaving(async () => {
      const r = await addConversationNote(info.ref, body);
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      setNote("");
      setMode("reply");
      showToast({ tone: "success", title: "Note saved. Only your team can see it." });
      router.refresh();
    });
  };

  const askDraft = async () => {
    if (!info || drafting) return;
    setDrafting(true);
    setMode("reply");
    try {
      const asked = await requestCopilot(info.ref, "DRAFT");
      if ("error" in asked) {
        showToast({ tone: "danger", title: asked.error });
        return;
      }
      // The worker writes it; a request that takes this long has stalled, and the Copilot tab still shows it.
      for (let i = 0; i < 60 && live.current; i++) {
        await new Promise((done) => setTimeout(done, 1500));
        const r = await readCopilotDrafts(info.ref);
        if ("error" in r) continue;
        const d = r.drafts.find((x) => x.id === asked.draft.id);
        if (!d || d.status === "PENDING" || d.status === "PROCESSING") continue;
        if (d.status === "COMPLETE" && d.responseText) {
          fillComposer(d.responseText);
          void markCopilotDraftUsed(d.id);
          showToast({ tone: "success", title: "Draft ready. Check it, then press Send." });
        } else {
          showToast({ tone: "info", title: d.warning ?? d.error ?? "AI could not draft a reply from what it knows. See the AI tab for why." });
          openPanel("copilot");
        }
        return;
      }
      if (live.current) showToast({ tone: "info", title: "The draft is taking longer than usual. It will appear in the AI tab." });
    } finally {
      if (live.current) setDrafting(false);
    }
  };

  const tab = (active: boolean) =>
    `inline-flex h-8 items-center gap-1.5 border-b-2 px-1 text-[12.5px] font-medium transition-colors ${
      active ? "border-[var(--color-accent)] text-[color:var(--color-foreground)]" : "border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
    }`;

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      {lastNote ? (
        <button
          type="button"
          onClick={() => openPanel("notes")}
          className="flex w-full min-w-0 items-center gap-2 border-b border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-1.5 text-left text-[12px] text-[color:var(--color-warning-fg)] transition-opacity hover:opacity-90 sm:px-5"
        >
          <StickyNote className="size-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium">{noteCount === 1 ? "1 team note" : `${noteCount} team notes`}</span>
          <span className="min-w-0 truncate opacity-85" dir="auto">
            {lastNote.body}
          </span>
        </button>
      ) : null}
      <div className="flex items-center gap-4 px-4 sm:px-5" role="tablist" aria-label="What to write">
        <button type="button" role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")} className={tab(mode === "reply")}>
          <MessageSquareText className="size-3.5" aria-hidden />
          Reply
        </button>
        {canNote ? (
          <button
            type="button"
            role="tab"
            aria-selected={mode === "note"}
            onClick={() => {
              setMode("note");
              requestAnimationFrame(() => noteBox.current?.focus());
            }}
            className={tab(mode === "note")}
          >
            <StickyNote className="size-3.5" aria-hidden />
            Note
          </button>
        ) : null}
        {canDraft ? (
          <>
            <span aria-hidden className="h-4 w-px bg-[var(--color-border)]" />
            <button
              type="button"
              disabled={drafting}
              onClick={() => void askDraft()}
              title="AI writes a reply into the box from your verified knowledge. You check it and press Send."
              className="inline-flex h-8 items-center gap-1.5 px-1 text-[12.5px] font-medium text-[color:var(--color-accent-fg)] transition-opacity hover:opacity-80 disabled:opacity-70"
            >
              {drafting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
              {drafting ? "Writing a draft…" : "AI draft"}
            </button>
          </>
        ) : null}
      </div>

      {mode === "note" ? (
        <div className="px-4 pb-3 pt-1 sm:px-5">
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]/50 focus-within:border-[var(--color-warning-fg)]">
            <textarea
              ref={noteBox}
              rows={2}
              value={note}
              maxLength={4000}
              dir="auto"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  saveNote();
                }
              }}
              placeholder="Write a note for your team. @mention someone to tell them."
              className="block max-h-48 min-h-[3.25rem] w-full resize-y bg-transparent px-3 py-2 text-[13.5px] leading-relaxed text-[color:var(--color-foreground)] outline-none placeholder:text-[color:var(--color-subtle-foreground)]"
            />
            <div className="flex items-center justify-between gap-3 px-2 pb-2">
              <span className="inline-flex items-center gap-1 pl-1 text-[11.5px] text-[color:var(--color-warning-fg)]">
                <Lock className="size-3" aria-hidden />
                The customer never sees this
              </span>
              <button
                type="button"
                onClick={saveNote}
                disabled={saving || !note.trim()}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-warning-fg)] px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                Save note
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className={mode === "note" ? "hidden" : undefined}>{children}</div>
    </div>
  );
}
