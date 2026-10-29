"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  AtSign,
  BookOpenCheck,
  Bot,
  Check,
  ChevronsRight,
  Copy,
  Flag,
  Loader2,
  NotebookPen,
  PanelRightOpen,
  Sparkles,
  StickyNote,
  Tag,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Users,
  Wand2,
  X,
} from "lucide-react";
import {
  CONVERSATION_PRIORITIES,
  CONVERSATION_PRIORITY_LABEL,
  COPILOT_REWRITE_INSTRUCTIONS,
  type ConversationPriorityValue,
  type CopilotRewriteInstruction,
} from "@support-automation/shared";
import { useToast } from "@/components/ui";
import { fillComposer, readComposer } from "@/lib/composerBridge";
import type { WorkspaceData, WorkspaceDraft, WorkspaceNote } from "@/server/inboxWorkspace";
import {
  addConversationNote,
  cancelCopilotRequest,
  deleteConversationNote,
  markCopilotDraftUsed,
  rateCopilotDraft,
  readCopilotDrafts,
  requestCopilot,
  setChannelConversationTeam,
  setConversationPriority,
  setConversationTags,
} from "@/server/actions/inboxWorkspace";

type TabKey = "details" | "notes" | "copilot";

const PRIORITY_DOT: Record<ConversationPriorityValue, string> = {
  NONE: "bg-[var(--color-border-strong)]",
  LOW: "bg-[var(--color-info-fg)]",
  NORMAL: "bg-[var(--color-success-fg)]",
  HIGH: "bg-[var(--color-warning-fg)]",
  URGENT: "bg-[var(--color-danger-fg)]",
};

// ── Collapsed preference (desktop), read without a render-time mismatch ─────────────────────────
const COLLAPSE_KEY = "inbox-workspace-collapsed";
const listeners = new Set<() => void>();
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    /* private mode: the panel still works, it just does not remember */
  }
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The inbox workspace side panel (INBOX_WORKSPACE.md). Desktop (xl): a 340 px column beside the
 * thread that collapses to a rail. Smaller screens: a button opens it as a sheet over the thread.
 *
 * What the server sent is the base; anything this browser just wrote (a note, a tag, a draft that is
 * still being polled) overlays it by id until the next refresh carries it too — so the layout's
 * four-second refresh never makes a fresh note flicker away.
 */
export function WorkspacePanel({ data }: { data: WorkspaceData }) {
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const firstTab: TabKey = data.access.collaboration ? "details" : "copilot";
  const [tab, setTab] = useState<TabKey>(firstTab);

  const tabs = [
    data.access.collaboration ? { key: "details" as const, label: "Details", icon: Tag } : null,
    data.access.collaboration ? { key: "notes" as const, label: "Notes", icon: StickyNote, count: data.notes.length } : null,
    data.access.copilot ? { key: "copilot" as const, label: "Copilot", icon: Sparkles } : null,
  ].filter((t): t is NonNullable<typeof t> => t !== null);

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Conversation workspace" className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
              tab === t.key
                ? "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]"
                : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            <t.icon className="size-3.5" aria-hidden />
            {t.label}
            {"count" in t && t.count ? <span className="rounded-full bg-[var(--color-surface)] px-1.5 text-[10.5px] tabular-nums ring-1 ring-[var(--color-border)]">{t.count}</span> : null}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => (sheetOpen ? setSheetOpen(false) : writeCollapsed(true))}
          aria-label="Close panel"
          className="flex size-7 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        >
          {sheetOpen ? <X className="size-4" aria-hidden /> : <ChevronsRight className="size-4" aria-hidden />}
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tab === "details" && data.access.collaboration ? <DetailsTab data={data} /> : null}
        {tab === "notes" && data.access.collaboration ? <NotesTab data={data} /> : null}
        {tab === "copilot" && data.access.copilot ? <CopilotTab data={data} /> : null}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop column */}
      {collapsed ? (
        <div className="hidden w-11 shrink-0 flex-col items-center gap-1 border-l border-[var(--color-border)] bg-[var(--color-surface)] py-2 xl:flex">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.label}
              aria-label={`Open ${t.label}`}
              onClick={() => {
                setTab(t.key);
                writeCollapsed(false);
              }}
              className="flex size-8 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
            >
              <t.icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        <aside aria-label="Conversation workspace" className="hidden w-[340px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] xl:flex">
          {body}
        </aside>
      )}

      {/* Smaller screens: a button and a sheet */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="fixed bottom-24 right-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface)] px-3.5 py-2 text-[12.5px] font-medium text-[color:var(--color-foreground)] shadow-[var(--shadow-lg)] ring-1 ring-[var(--color-border)] xl:hidden"
      >
        <PanelRightOpen className="size-4" aria-hidden />
        {data.access.copilot ? "Notes & Copilot" : "Notes"}
      </button>
      {sheetOpen ? (
        <div className="fixed inset-0 z-50 xl:hidden" role="dialog" aria-modal="true" aria-label="Conversation workspace">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30" onClick={() => setSheetOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-[400px] flex-col bg-[var(--color-surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-lg)]">{body}</div>
        </div>
      ) : null}
    </>
  );
}

// ── Details ─────────────────────────────────────────────────────────────────────────────────────

function DetailsTab({ data }: { data: WorkspaceData }) {
  const { showToast } = useToast();
  const [priority, setPriority] = useState<ConversationPriorityValue | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [team, setTeam] = useState<string | null | undefined>(undefined);
  const [draftTag, setDraftTag] = useState("");
  const [pending, start] = useTransition();
  const shownPriority = priority ?? data.priority;
  const shownTags = tags ?? data.tags;
  const shownTeam = team === undefined ? data.assignedTeamId : team;
  const ro = !data.access.canWrite;

  const fail = (error: string) => showToast({ tone: "danger", title: error });

  const choosePriority = (p: ConversationPriorityValue) => {
    if (ro || p === shownPriority) return;
    setPriority(p);
    start(async () => {
      const r = await setConversationPriority(data.ref, p);
      if ("error" in r) {
        setPriority(null);
        fail(r.error);
      }
    });
  };

  const saveTags = (next: string[]) => {
    setTags(next);
    start(async () => {
      const r = await setConversationTags(data.ref, next);
      if ("error" in r) {
        setTags(null);
        fail(r.error);
      } else setTags(r.tags);
    });
  };

  const addTag = () => {
    const value = draftTag.trim();
    if (!value) return;
    setDraftTag("");
    saveTags([...shownTags, value]);
  };

  return (
    <div className="space-y-5 p-4">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
          <Flag className="size-3.5" aria-hidden />
          Priority
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {CONVERSATION_PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              disabled={ro || pending}
              aria-pressed={shownPriority === p}
              onClick={() => choosePriority(p)}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] ring-1 transition-colors disabled:cursor-not-allowed ${
                shownPriority === p
                  ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)] ring-[var(--color-border-strong)]"
                  : "text-[color:var(--color-muted-foreground)] ring-[var(--color-border)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              <span className={`size-2 rounded-full ${PRIORITY_DOT[p]}`} aria-hidden />
              {p === "NONE" ? "None" : CONVERSATION_PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
          <Tag className="size-3.5" aria-hidden />
          Tags
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {shownTags.length === 0 ? <span className="text-[12px] text-[color:var(--color-subtle-foreground)]">No tags yet.</span> : null}
          {shownTags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-info-bg)] px-2 py-0.5 text-[12px] text-[color:var(--color-info-fg)]">
              #{t}
              {!ro ? (
                <button type="button" aria-label={`Remove tag ${t}`} onClick={() => saveTags(shownTags.filter((x) => x !== t))} className="opacity-70 hover:opacity-100">
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
        </div>
        {!ro ? (
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              addTag();
            }}
          >
            <input
              value={draftTag}
              onChange={(e) => setDraftTag(e.target.value)}
              list="inbox-known-tags"
              placeholder="Add a tag, e.g. billing"
              maxLength={40}
              className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
            />
            <datalist id="inbox-known-tags">
              {data.knownTags.filter((t) => !shownTags.includes(t)).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <button type="submit" disabled={pending || !draftTag.trim()} className="rounded-[var(--radius-md)] px-2.5 text-[12.5px] font-medium ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50">
              Add
            </button>
          </form>
        ) : null}
      </section>

      {data.teams ? (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
            <Users className="size-3.5" aria-hidden />
            Team
          </h3>
          <select
            value={shownTeam ?? ""}
            disabled={ro || pending}
            onChange={(e) => {
              const next = e.target.value || null;
              setTeam(next);
              start(async () => {
                const r = await setChannelConversationTeam((data.ref as { conversationId: string }).conversationId, next);
                if ("error" in r) {
                  setTeam(undefined);
                  fail(r.error);
                }
              });
            }}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px]"
          >
            <option value="">No Team</option>
            {data.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-[color:var(--color-subtle-foreground)]">The person handling it is set with Assign in the header.</p>
        </section>
      ) : null}

      {ro ? <p className="text-[11.5px] text-[color:var(--color-subtle-foreground)]">Your role can read this conversation but not change it.</p> : null}
    </div>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────────────────────────

function NotesTab({ data }: { data: WorkspaceData }) {
  const { showToast } = useToast();
  const [added, setAdded] = useState<WorkspaceNote[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);

  const notes = useMemo(() => {
    const ids = new Set(data.notes.map((n) => n.id));
    return [...data.notes, ...added.filter((n) => !ids.has(n.id))].filter((n) => !removed.includes(n.id));
  }, [data.notes, added, removed]);

  const mentionQuery = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(text)?.[1];
  const suggestions =
    mentionQuery === undefined ? [] : data.people.filter((p) => p.username.toLowerCase().startsWith(mentionQuery.toLowerCase()) || p.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6);

  const save = () => {
    const body = text.trim();
    if (!body || pending) return;
    start(async () => {
      const r = await addConversationNote(data.ref, body);
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      setAdded((a) => [...a, r.note]);
      setText("");
    });
  };

  const peopleById = new Map(data.people.map((p) => [p.id, p]));

  return (
    <div className="flex h-full flex-col">
      <ol className="flex-1 space-y-2.5 p-4">
        {notes.length === 0 ? (
          <li className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-4 text-center text-[12.5px] text-[color:var(--color-muted-foreground)]">
            <NotebookPen className="mx-auto mb-1.5 size-5 opacity-60" aria-hidden />
            Notes are for your team only — they are never sent to the customer.
          </li>
        ) : null}
        {notes.map((n) => (
          <li key={n.id} className="rounded-[var(--radius-lg)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]/60 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
              <span className="font-semibold text-[color:var(--color-foreground)]">{n.authorId === data.viewerId ? "You" : n.authorName}</span>
              <RelTime iso={n.createdAt} />
              <span className="flex-1" />
              {n.authorId === data.viewerId && data.access.canWrite ? (
                <button
                  type="button"
                  aria-label="Delete note"
                  onClick={() =>
                    start(async () => {
                      const r = await deleteConversationNote(n.id);
                      if ("error" in r) showToast({ tone: "danger", title: r.error });
                      else setRemoved((x) => [...x, n.id]);
                    })
                  }
                  className="opacity-60 hover:opacity-100"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[color:var(--color-foreground)] [overflow-wrap:anywhere]">
              <MentionText body={n.body} />
            </p>
            {n.mentionedUserIds.includes(data.viewerId) ? <p className="mt-1 text-[11px] font-medium text-[color:var(--color-warning-fg)]">You were mentioned</p> : null}
            {n.mentionedUserIds.length && !n.mentionedUserIds.includes(data.viewerId) ? (
              <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">Mentions: {n.mentionedUserIds.map((id) => peopleById.get(id)?.name ?? "someone").join(", ")}</p>
            ) : null}
          </li>
        ))}
      </ol>

      {data.access.canWrite ? (
        <div className="sticky bottom-0 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          {suggestions.length ? (
            <ul className="mb-2 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {suggestions.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setText((t) => t.replace(/@([A-Za-z0-9._-]*)$/, `@${p.username} `));
                      box.current?.focus();
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-neutral-bg)]"
                  >
                    <AtSign className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-[color:var(--color-subtle-foreground)]">@{p.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
            }}
            rows={3}
            maxLength={4000}
            placeholder="Internal note — @mention a teammate. Never sent to the customer."
            className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]/40 px-3 py-2 text-[13px] outline-none focus:border-[var(--color-warning-fg)]"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[11px] text-[color:var(--color-subtle-foreground)]">Ctrl + Enter to save</span>
            <button
              type="button"
              onClick={save}
              disabled={pending || !text.trim()}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-warning-fg)] px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <StickyNote className="size-3.5" aria-hidden />}
              Save note
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MentionText({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z0-9._-]{2,64})/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-medium text-[color:var(--color-info-fg)]">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

// ── Copilot ─────────────────────────────────────────────────────────────────────────────────────

function CopilotTab({ data }: { data: WorkspaceData }) {
  const { showToast } = useToast();
  const [local, setLocal] = useState<Record<string, WorkspaceDraft>>({});
  const [pending, start] = useTransition();

  const drafts = useMemo(() => {
    const byId = new Map<string, WorkspaceDraft>();
    for (const d of data.drafts) byId.set(d.id, d);
    for (const d of Object.values(local)) {
      const server = byId.get(d.id);
      // The newer reading wins: a finished server row over a pending local one, and vice versa.
      if (!server || rank(d) >= rank(server)) byId.set(d.id, d);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  }, [data.drafts, local]);

  const working = drafts.some((d) => d.status === "PENDING" || d.status === "PROCESSING");

  // Poll only while a request is in flight; the panel is otherwise refreshed with the page.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(async () => {
      const r = await readCopilotDrafts(data.ref);
      if ("drafts" in r) setLocal((prev) => ({ ...prev, ...Object.fromEntries(r.drafts.map((d) => [d.id, d])) }));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [working, data.ref]);

  const ask = (mode: "ASSIST" | "DRAFT" | "REWRITE", options?: { instruction: CopilotRewriteInstruction; baseText: string }) => {
    start(async () => {
      const r = await requestCopilot(data.ref, mode, options);
      if ("error" in r) showToast({ tone: "danger", title: r.error });
      else setLocal((prev) => ({ ...prev, [r.draft.id]: r.draft }));
    });
  };

  if (!data.access.canWrite) {
    return <p className="p-4 text-[12.5px] text-[color:var(--color-muted-foreground)]">Your role can read this conversation but not ask the Copilot about it.</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending || working}
          onClick={() => ask("ASSIST")}
          className="flex flex-col items-start gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50"
        >
          <BookOpenCheck className="size-4 text-[color:var(--color-info-fg)]" aria-hidden />
          <span className="text-[12.5px] font-semibold">Summarise & suggest</span>
          <span className="text-[11px] leading-snug text-[color:var(--color-muted-foreground)]">What they need, verified knowledge, next steps</span>
        </button>
        <button
          type="button"
          disabled={pending || working}
          onClick={() => ask("DRAFT")}
          className="flex flex-col items-start gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50"
        >
          <Sparkles className="size-4 text-[color:var(--color-accent)]" aria-hidden />
          <span className="text-[12.5px] font-semibold">Draft a reply</span>
          <span className="text-[11px] leading-snug text-[color:var(--color-muted-foreground)]">To the latest customer message — you review and send</span>
        </button>
      </div>

      <RewriteRow
        disabled={pending || working}
        onPick={(instruction) => {
          const typed = readComposer()?.trim();
          if (!typed) {
            showToast({ tone: "info", title: "Type something in the reply box first, then pick a rewrite." });
            return;
          }
          ask("REWRITE", { instruction, baseText: typed });
        }}
        label="Rewrite what I typed"
      />

      <ol className="space-y-3">
        {drafts.length === 0 ? (
          <li className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-4 text-center text-[12px] text-[color:var(--color-muted-foreground)]">
            <Bot className="mx-auto mb-1.5 size-5 opacity-60" aria-hidden />
            The Copilot reads this conversation and your verified knowledge base. It never sends anything.
          </li>
        ) : null}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} mine={d.requestedById === data.viewerId} disabled={pending || working} onRewrite={(instruction, baseText) => ask("REWRITE", { instruction, baseText })} onChange={(next) => setLocal((prev) => ({ ...prev, [next.id]: next }))} />
        ))}
      </ol>
    </div>
  );
}

function rank(d: WorkspaceDraft): number {
  return d.status === "COMPLETE" || d.status === "FAILED" || d.status === "CANCELLED" ? 2 : d.status === "PROCESSING" ? 1 : 0;
}

function RewriteRow({ disabled, onPick, label }: { disabled: boolean; onPick: (i: CopilotRewriteInstruction) => void; label: string }) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
        <Wand2 className="size-3.5" aria-hidden />
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(COPILOT_REWRITE_INSTRUCTIONS) as CopilotRewriteInstruction[]).map((key) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onPick(key)}
            className="rounded-full px-2.5 py-1 text-[11.5px] text-[color:var(--color-muted-foreground)] ring-1 ring-[var(--color-border)] transition-colors hover:text-[color:var(--color-foreground)] hover:ring-[var(--color-border-strong)] disabled:opacity-50"
          >
            {COPILOT_REWRITE_INSTRUCTIONS[key].label}
          </button>
        ))}
      </div>
    </div>
  );
}

const MODE_LABEL = { ASSIST: "Summary", DRAFT: "Suggested reply", REWRITE: "Rewrite" } as const;

function DraftCard({
  draft: d,
  mine,
  disabled,
  onRewrite,
  onChange,
}: {
  draft: WorkspaceDraft;
  mine: boolean;
  disabled: boolean;
  onRewrite: (i: CopilotRewriteInstruction, text: string) => void;
  onChange: (d: WorkspaceDraft) => void;
}) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const busy = d.status === "PENDING" || d.status === "PROCESSING";

  const use = () => {
    if (!d.responseText) return;
    if (!fillComposer(d.responseText)) {
      showToast({ tone: "info", title: "There is no reply box open here to put it in. Use Copy instead." });
      return;
    }
    onChange({ ...d, usedAt: new Date().toISOString() });
    void markCopilotDraftUsed(d.id);
  };

  const rate = (value: "UP" | "DOWN") => {
    const next = d.feedback === value ? null : value;
    onChange({ ...d, feedback: next });
    void rateCopilotDraft(d.id, next);
  };

  return (
    <li className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-[11px] text-[color:var(--color-muted-foreground)]">
        <Sparkles className="size-3.5 text-[color:var(--color-accent)]" aria-hidden />
        <span className="font-semibold text-[color:var(--color-foreground)]">
          {MODE_LABEL[d.mode]}
          {d.mode === "REWRITE" && d.instruction ? ` · ${COPILOT_REWRITE_INSTRUCTIONS[d.instruction as CopilotRewriteInstruction]?.label ?? ""}` : ""}
        </span>
        <RelTime iso={d.createdAt} />
        {d.requestedByName ? <span className="truncate">· {d.requestedByName}</span> : null}
      </div>

      <div className="space-y-2.5 px-3 py-2.5 text-[13px]">
        {busy ? (
          <p className="flex items-center gap-2 text-[color:var(--color-muted-foreground)]">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {d.mode === "ASSIST" ? "Reading the conversation…" : "Writing…"}
            {mine ? (
              <button
                type="button"
                onClick={async () => {
                  const r = await cancelCopilotRequest(d.id);
                  if ("error" in r) showToast({ tone: "info", title: r.error });
                  else onChange({ ...d, status: "CANCELLED", reason: "Cancelled by you." });
                }}
                className="ml-auto text-[12px] underline-offset-2 hover:underline"
              >
                Cancel
              </button>
            ) : null}
          </p>
        ) : null}
        {d.status === "CANCELLED" ? <p className="text-[color:var(--color-muted-foreground)]">{d.reason ?? "Cancelled."}</p> : null}
        {d.status === "FAILED" ? <p className="text-[color:var(--color-danger-fg)]">The Copilot could not finish: {d.error ?? "unknown error"}. Try again.</p> : null}
        {d.status === "COMPLETE" && !d.responseText && !d.summary && d.reason ? <p className="text-[color:var(--color-muted-foreground)]">{explainReason(d.reason)}</p> : null}

        {d.summary ? <p className="leading-relaxed">{d.summary}</p> : null}
        {d.intent && d.mode === "ASSIST" ? (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Intent: <span className="font-medium text-[color:var(--color-foreground)]">{d.intent}</span>
          </p>
        ) : null}
        {d.nextSteps.length ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">Next steps</p>
            <ol className="list-decimal space-y-0.5 pl-5 text-[12.5px]">
              {d.nextSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        ) : null}

        {d.responseText && d.mode === "DRAFT" ? (
          d.grounded ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-success-fg)]">
              <BookOpenCheck className="size-3" aria-hidden />
              Based on verified knowledge — still review before sending
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-danger-bg)] px-2 py-0.5 text-[11px] font-semibold text-[color:var(--color-danger-fg)]">
              <TriangleAlert className="size-3" aria-hidden />
              Not verified
            </span>
          )
        ) : null}
        {d.warning ? (
          <p
            role="alert"
            className={`flex gap-1.5 rounded-[var(--radius-md)] px-2.5 py-2 text-[12px] ${
              d.scope === "BUSINESS_SPECIFIC" && !d.grounded
                ? "border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] font-medium text-[color:var(--color-danger-fg)]"
                : "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"
            }`}
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {d.warning}
          </p>
        ) : null}
        {d.responseText ? <p className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 leading-relaxed [overflow-wrap:anywhere]">{d.responseText}</p> : null}

        {d.status === "COMPLETE" && d.mode !== "REWRITE" ? (
          d.knowledgeTitles.length ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">From verified knowledge</p>
              <ul className="space-y-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">
                {d.knowledgeTitles.map((t) => (
                  <li key={t} className="flex items-center gap-1.5">
                    <BookOpenCheck className="size-3 shrink-0 text-[color:var(--color-success-fg)]" aria-hidden />
                    <span className="truncate">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[11.5px] text-[color:var(--color-subtle-foreground)]">No verified knowledge matched this conversation.</p>
          )
        ) : null}
      </div>

      {d.responseText ? (
        <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={use} className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)]">
              {d.usedAt ? <Check className="size-3.5" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
              {d.usedAt ? "Put in reply box" : "Use in reply"}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(d.responseText!);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                } catch {
                  showToast({ tone: "info", title: "Copying is blocked in this browser." });
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12px] ring-1 ring-[var(--color-border)] hover:bg-[var(--color-neutral-bg)]"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
            <span className="flex-1" />
            <button type="button" aria-label="Good suggestion" aria-pressed={d.feedback === "UP"} onClick={() => rate("UP")} className={`rounded p-1 ${d.feedback === "UP" ? "text-[color:var(--color-success-fg)]" : "text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]"}`}>
              <ThumbsUp className="size-3.5" aria-hidden />
            </button>
            <button type="button" aria-label="Poor suggestion" aria-pressed={d.feedback === "DOWN"} onClick={() => rate("DOWN")} className={`rounded p-1 ${d.feedback === "DOWN" ? "text-[color:var(--color-danger-fg)]" : "text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]"}`}>
              <ThumbsDown className="size-3.5" aria-hidden />
            </button>
          </div>
          <details className="text-[12px]">
            <summary className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">Rewrite this…</summary>
            <div className="mt-2">
              <RewriteRow disabled={disabled} onPick={(i) => onRewrite(i, d.responseText!)} label="Rewrite" />
            </div>
          </details>
        </div>
      ) : null}
    </li>
  );
}

function explainReason(reason: string): string {
  const code = reason.split(":")[0];
  switch (code) {
    case "AI_UNAVAILABLE":
      return `The AI is not available: ${reason.slice(reason.indexOf(":") + 1).trim()}`;
    case "NO_CUSTOMER_MESSAGE":
      return "There is no customer message with text to answer yet.";
    case "AI_DECLINED":
      return "The AI would not answer this from what it knows. Answer it yourself, or add the answer to the knowledge base.";
    case "MALFORMED_RESPONSE":
    case "EMPTY_RESPONSE":
      return "The AI's answer could not be read. Try again.";
    case "NOTHING_TO_REWRITE":
      return "There was no text to rewrite.";
    default:
      return reason;
  }
}

function RelTime({ iso }: { iso: string }) {
  // Relative to "now", which differs between the server render and the browser by a few seconds.
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {relativeTime(iso)}
    </time>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" });
}
