"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Info, RotateCw, ShieldCheck } from "lucide-react";
import type { BusinessAppDefinition } from "@support-automation/shared";
import { Button } from "@/components/ui";
import { BusinessAppIcon } from "@/components/businessApps/BusinessAppIcon";
import ProjectLink from "@/components/ProjectLink";
import { launchBusinessApp } from "@/server/actions/businessApps";

/**
 * A connected app's own dashboard inside the workspace: the app's real frontend, on its OWN origin, in a
 * sandboxed frame. Nothing of this product goes into it — no cookie, no token, no script. The frame opens on
 * the app's single-use sign-in address (`launchBusinessApp`), so a person who linked their app account once is
 * signed straight in; when the app cannot hand one over, the frame opens the app's own sign-in instead. The
 * frame is shown at all only after the server has decided this person may open this app in this project.
 *
 * `allow-same-origin` is safe here only because the app is on a different origin (the page checks that):
 * it lets the app keep its own sign-in, never reach this page.
 */
export function EmbeddedBusinessApp({
  app,
  projectName,
  src,
  path,
  workspaceId,
}: {
  app: Pick<BusinessAppDefinition, "key" | "name" | "icon">;
  projectName: string;
  /** The app's own page, without a sign-in hand-off: the fallback and the "New tab" address. */
  src: string;
  /** The page inside the app to land on. */
  path: string;
  workspaceId: string | null;
}) {
  const [frame, setFrame] = useState<{ key: number; src: string | null; note: string | null }>({ key: 0, src: null, note: null });
  const started = useRef(false);

  // Every open (and every reload) asks for a fresh single-use sign-in: a used code cannot be loaded twice.
  const open = useCallback(() => {
    setFrame((f) => ({ key: f.key + 1, src: null, note: f.note }));
    launchBusinessApp(app.key, path)
      .then((r) =>
        setFrame((f) =>
          r.redirectUrl
            ? { ...f, src: r.redirectUrl, note: null }
            : { ...f, src, note: r.error ?? `${app.name} could not sign you in automatically.` },
        ),
      )
      .catch(() => setFrame((f) => ({ ...f, src, note: `${app.name} could not sign you in automatically.` })));
  }, [app.key, app.name, path, src]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open();
  }, [open]);

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
          <Button size="sm" variant="ghost" onClick={open} aria-label={`Reload ${app.name}`}>
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
      {frame.note ? (
        <p className="flex items-start gap-2 border-x border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {frame.note} Sign in with your {app.name} account below.
          </span>
        </p>
      ) : null}
      {frame.src ? (
        <iframe
          key={frame.key}
          src={frame.src}
          title={`${app.name} — ${projectName}`}
          className="h-[calc(100dvh-10.5rem)] min-h-[520px] w-full border-0 bg-[var(--color-surface)] sm:rounded-b-[var(--radius-lg)] sm:border sm:border-[var(--color-border)]"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerPolicy="no-referrer"
          allow="clipboard-write"
        />
      ) : (
        <div
          role="status"
          className="flex h-[calc(100dvh-10.5rem)] min-h-[520px] w-full items-center justify-center bg-[var(--color-surface)] text-[13px] text-[color:var(--color-muted-foreground)] sm:rounded-b-[var(--radius-lg)] sm:border sm:border-[var(--color-border)]"
        >
          Signing you in to {app.name}…
        </div>
      )}
    </div>
  );
}
