"use client";

import { AlertTriangle, Clock, Inbox, MailOpen, UserRound, type LucideIcon } from "lucide-react";
import type { InboxCounts, InboxChannel } from "@/server/channels/inbox";
import type { UniversalProjectView } from "@/server/universalInbox";
import { ChannelMark } from "./ChannelMark";

export const projectColor = (index: number): string => `var(--chart-${(index % 6) + 1})`;

function relative(iso: string | null): string {
  if (!iso) return "No messages yet";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function Figure({ icon: Icon, label, value, warn = false }: { icon: LucideIcon; label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] ${warn ? "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}>
        <Icon className="size-4.5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="tabular block text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[color:var(--color-foreground)]">{value.toLocaleString("en-US")}</span>
        <span className="block truncate text-[12px] text-[color:var(--color-muted-foreground)]">{label}</span>
      </span>
    </div>
  );
}

const CHANNELS: InboxChannel[] = ["WHATSAPP", "MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBCHAT"];

/**
 * What the All projects inbox shows before a conversation is opened: where attention is needed, project by project. Every
 * figure is the list's own count, added up, and pressing a project narrows the list beside it.
 */
export function UniversalBoard({
  counts,
  projects,
  unavailable,
  onPick,
}: {
  counts: InboxCounts;
  projects: UniversalProjectView[];
  unavailable: string[];
  onPick: (slug: string) => void;
}) {
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface-sunken)] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-[color:var(--color-foreground)]">All projects</h2>
        <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">Every conversation you can read, in one list. Open any of them to reply from here.</p>

        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Figure icon={Inbox} label="Open" value={counts.all} />
          <Figure icon={Clock} label="Waiting for a reply" value={counts.needsReply} warn={counts.needsReply > 0} />
          <Figure icon={MailOpen} label="Unread" value={counts.unread} />
          <Figure icon={UserRound} label="Assigned to you" value={counts.mine} />
        </div>

        <h3 className="mb-2 mt-6 text-[12.5px] font-semibold text-[color:var(--color-muted-foreground)]">By project</h3>
        <ul className="space-y-2">
          {projects.map((project) => (
            <li key={project.slug}>
              <button
                type="button"
                onClick={() => onPick(project.slug)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] sm:grid-cols-[minmax(0,1fr)_auto_auto]"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: projectColor(project.colorIndex) }} />
                    <span className="truncate text-[14px] font-semibold text-[color:var(--color-foreground)]">{project.name}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 pl-4.5 text-[12px] text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                    {relative(project.lastMessageAt)}
                    {project.problems > 0 ? (
                      <span className="inline-flex items-center gap-1 font-medium text-[color:var(--color-danger-fg)]">
                        <AlertTriangle className="size-3" aria-hidden />
                        {project.problems} need a look
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="hidden items-center gap-2 sm:flex">
                  {CHANNELS.filter((c) => project.counts.byChannel[c] > 0).map((c) => (
                    <span key={c} className="tabular inline-flex items-center gap-1 text-[12px] text-[color:var(--color-muted-foreground)]">
                      <ChannelMark channel={c} size="xs" />
                      {project.counts.byChannel[c].toLocaleString("en-US")}
                    </span>
                  ))}
                </span>
                <span className="tabular text-right text-[13px]">
                  <span className={project.counts.needsReply > 0 ? "font-semibold text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}>{project.counts.needsReply.toLocaleString("en-US")} waiting</span>
                  <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">{project.counts.all.toLocaleString("en-US")} open</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {unavailable.length ? <p className="mt-3 text-[12.5px] text-[color:var(--color-warning-fg)]">Could not read {unavailable.join(", ")} just now. It will come back on the next refresh.</p> : null}
      </div>
    </div>
  );
}
