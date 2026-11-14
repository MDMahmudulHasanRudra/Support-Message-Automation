"use client";

import { useState } from "react";
import { ArrowLeft, ExternalLink, RotateCw, ShieldCheck } from "lucide-react";
import type { BusinessAppDefinition } from "@support-automation/shared";
import { Button } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import ProjectLink from "@/components/ProjectLink";

/**
 * A connected app's own dashboard inside the workspace: the app's real frontend, on its OWN origin, in a
 * sandboxed frame. Nothing of this product goes into it — no cookie, no token, no script; the address carries
 * only a path inside the app. The app signs the person in itself and its own roles decide what they may do;
 * the frame is shown at all only after the server has decided this person may open this app in this project.
 *
 * `allow-same-origin` is safe here only because the app is on a different origin (the page checks that):
 * it lets the app keep its own sign-in, never reach this page.
 */
export function EmbeddedBusinessApp({
  app,
  projectName,
  src,
  workspaceId,
}: {
  app: Pick<BusinessAppDefinition, "key" | "name" | "icon">;
  projectName: string;
  src: string;
  workspaceId: string | null;
}) {
  const [frameKey, setFrameKey] = useState(0);
  return (
    <div className="-mx-4 -mt-2 flex flex-col sm:mx-0 sm:mt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 sm:rounded-t-[var(--radius-lg)] sm:border sm:border-b-0">
        <ProjectLink
          href="/overview"
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to {projectName}
        </ProjectLink>
        <span aria-hidden className="hidden h-4 w-px bg-[var(--color-border)] sm:block" />
        <span className="flex min-w-0 items-center gap-2">
          <BusinessAppIcon icon={app.icon} className="size-4 shrink-0 text-[color:var(--color-accent)]" />
          <span className="text-[13.5px] font-semibold text-[color:var(--color-foreground)]">{app.name}</span>
          <span className="hidden items-center gap-1 truncate text-[12px] text-[color:var(--color-subtle-foreground)] md:inline-flex" title={workspaceId ?? undefined}>
            <ShieldCheck className="size-3.5 shrink-0 text-[color:var(--color-success)]" aria-hidden />
            Connected to this project&apos;s {app.name} workspace
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setFrameKey((k) => k + 1)} aria-label={`Reload ${app.name}`}>
            <RotateCw className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Reload</span>
          </Button>
          {/* A plain anchor: the app's absolute address must not be rewritten into a project path. */}
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium text-[color:var(--color-foreground)] hover:bg-[var(--color-surface-sunken)]"
          >
            <span className="hidden sm:inline">New tab</span>
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </span>
      </div>
      <iframe
        key={frameKey}
        src={src}
        title={`${app.name} — ${projectName}`}
        className="h-[calc(100dvh-10.5rem)] min-h-[520px] w-full border-0 bg-[var(--color-surface)] sm:rounded-b-[var(--radius-lg)] sm:border sm:border-[var(--color-border)]"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        referrerPolicy="no-referrer"
        allow="clipboard-write"
      />
    </div>
  );
}
