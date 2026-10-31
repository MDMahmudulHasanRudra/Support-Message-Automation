"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { isSocialPlatform, SOCIAL_PLATFORMS, validateForPlatform, type SocialMediaKind } from "@support-automation/shared";
import { useProjectHref, useProjectRouter } from "@/components/ProjectLink";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { saveSocialPostAction, type SocialActionState } from "@/server/actions/social";
import { COMMON_TIME_ZONES } from "./socialUi";

/**
 * The Social Studio composer (SOCIAL_STUDIO.md §Composer), for a new post and for editing one. Saving
 * always leaves a DRAFT (or sends it for approval); nothing here publishes. The preview applies each
 * platform's documented limits as you type, and the server checks the same rules again.
 */

export interface ComposerAccount {
  id: string;
  platform: string;
  name: string;
  username: string | null;
  usable: boolean;
}
export interface ComposerAsset {
  id: string;
  name: string;
  kind: SocialMediaKind;
  mimeType: string;
  sizeBytes: number;
}
export interface ComposerTemplate {
  id: string;
  kind: string;
  name: string;
  content: string;
}
export interface ComposerInitial {
  id?: string;
  revision?: number;
  title: string;
  content: string;
  accountIds: string[];
  variants: Record<string, string>;
  settings: Record<string, Record<string, unknown>>;
  mediaIds: string[];
  campaignId: string;
  publishMode: "SCHEDULE" | "NOW";
  scheduledLocal: string;
  timezone: string;
  aiAssisted: boolean;
}

export function PostComposer({
  initial,
  accounts,
  assets: initialAssets,
  campaigns,
  templates,
}: {
  initial: ComposerInitial;
  accounts: ComposerAccount[];
  assets: ComposerAsset[];
  campaigns: Array<{ id: string; name: string }>;
  templates: ComposerTemplate[];
}) {
  const router = useProjectRouter();
  const toProject = useProjectHref();
  const [state, action, pending] = useActionState<SocialActionState, FormData>(saveSocialPostAction, {});
  const [content, setContent] = useState(initial.content);
  const [selected, setSelected] = useState<string[]>(initial.accountIds);
  const [variants, setVariants] = useState<Record<string, string>>(initial.variants);
  const [settings, setSettings] = useState<Record<string, Record<string, unknown>>>(initial.settings);
  const [openVariant, setOpenVariant] = useState<string | null>(null);
  const [assets, setAssets] = useState<ComposerAsset[]>(initialAssets);
  const [mediaIds, setMediaIds] = useState<string[]>(initial.mediaIds);
  const [mode, setMode] = useState<"SCHEDULE" | "NOW">(initial.publishMode);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [aiAssisted] = useState(initial.aiAssisted);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.id && !initial.id) router.push(`/social/posts/${state.id}`);
  }, [state.id, initial.id, router]);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const chosenMedia = mediaIds.map((id) => assetById.get(id)).filter((a): a is ComposerAsset => Boolean(a));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const insert = (text: string) => {
    const el = box.current;
    if (!el) return setContent((c) => `${c}${c && !c.endsWith("\n") ? "\n" : ""}${text}`);
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const next = `${content.slice(0, start)}${text}${content.slice(end)}`;
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  };

  const toggleAccount = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleMedia = (id: string) => setMediaIds((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const setSetting = (accountId: string, key: string, value: unknown) =>
    setSettings((s) => {
      const next = { ...(s[accountId] ?? {}) };
      if (value === "" || value === null || value === undefined) delete next[key];
      else next[key] = value;
      return { ...s, [accountId]: next };
    });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch(toProject("/api/social/upload"), { method: "POST", body });
        const json = (await response.json().catch(() => ({}))) as { asset?: ComposerAsset; error?: string };
        if (!response.ok || !json.asset) {
          setUploadError(json.error ?? "The upload failed.");
          break;
        }
        setAssets((a) => [json.asset!, ...a]);
        setMediaIds((m) => [...m, json.asset!.id]);
      }
    } catch {
      setUploadError("The upload failed. Check the connection and try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const grouped = (kind: string) => templates.filter((t) => t.kind === kind);

  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      {initial.revision ? <input type="hidden" name="revision" value={initial.revision} /> : null}
      <input type="hidden" name="aiAssisted" value={aiAssisted ? "1" : "0"} />
      {selected.map((id) => (
        <span key={id}>
          <input type="hidden" name="account" value={id} />
          <input type="hidden" name={`variant_${id}`} value={variants[id] ?? ""} />
          <input type="hidden" name={`settings_${id}`} value={settings[id] && Object.keys(settings[id]!).length ? JSON.stringify(settings[id]) : ""} />
        </span>
      ))}
      {mediaIds.map((id) => (
        <input key={id} type="hidden" name="media" value={id} />
      ))}

      <div className="min-w-0 space-y-5">
        <Field label="Internal name" htmlFor="title" hint="For the calendar and lists. Never published.">
          <Input id="title" name="title" defaultValue={initial.title} maxLength={120} />
        </Field>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="content" className="text-sm font-medium">
              Text
            </label>
            <div className="flex flex-wrap gap-2">
              {(["TEMPLATE", "SIGNATURE", "HASHTAGS"] as const).map((kind) =>
                grouped(kind).length ? (
                  <select
                    key={kind}
                    aria-label={kind === "TEMPLATE" ? "Insert a template" : kind === "SIGNATURE" ? "Insert a signature" : "Insert hashtags"}
                    className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
                    value=""
                    onChange={(e) => {
                      const t = templates.find((x) => x.id === e.target.value);
                      if (t) insert(kind === "TEMPLATE" ? t.content : `\n\n${t.content}`);
                    }}
                  >
                    <option value="">{kind === "TEMPLATE" ? "Template…" : kind === "SIGNATURE" ? "Signature…" : "Hashtags…"}</option>
                    {grouped(kind).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : null,
              )}
            </div>
          </div>
          <Textarea ref={box} id="content" name="content" rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder="What do you want to say?" />
          <p className="mt-1 text-xs tabular text-[color:var(--color-muted-foreground)]">{[...content].length.toLocaleString("en-US")} characters</p>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-medium">Accounts</p>
          {accounts.length === 0 ? (
            <Alert tone="warning" title="No account is connected. Connect Facebook / Instagram under Social Studio → Accounts." />
          ) : (
            <ul className="space-y-2">
              {accounts.map((a) => {
                const on = selected.includes(a.id);
                const rules = isSocialPlatform(a.platform) ? SOCIAL_PLATFORMS[a.platform] : null;
                return (
                  <li key={a.id} className={`rounded-[var(--radius-md)] border p-3 ${on ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={on} disabled={!a.usable && !on} onChange={() => toggleAccount(a.id)} />
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">
                        {rules?.label ?? a.platform}
                        {a.username ? ` · @${a.username}` : ""}
                        {!a.usable ? " · needs attention" : ""}
                      </span>
                    </label>
                    {on ? (
                      <div className="mt-2 space-y-2 pl-6">
                        {a.platform === "FACEBOOK_PAGE" ? (
                          <Input
                            aria-label={`Link for ${a.name}`}
                            placeholder="Link to share (optional, text posts only)"
                            defaultValue={typeof settings[a.id]?.link === "string" ? String(settings[a.id]!.link) : ""}
                            onChange={(e) => setSetting(a.id, "link", e.target.value.trim())}
                          />
                        ) : null}
                        {a.platform === "INSTAGRAM" ? (
                          <Select aria-label={`Instagram format for ${a.name}`} defaultValue={settings[a.id]?.igMediaType === "STORIES" ? "STORIES" : ""} onChange={(e) => setSetting(a.id, "igMediaType", e.target.value)}>
                            <option value="">Feed post / Reel</option>
                            <option value="STORIES">Story</option>
                          </Select>
                        ) : null}
                        <button type="button" className="link text-xs" onClick={() => setOpenVariant(openVariant === a.id ? null : a.id)}>
                          {variants[a.id] ? "Edit this account's own text" : "Write different text for this account"}
                        </button>
                        {openVariant === a.id || variants[a.id] ? (
                          <Textarea
                            aria-label={`Own text for ${a.name}`}
                            rows={3}
                            value={variants[a.id] ?? ""}
                            placeholder="Empty = the main text"
                            onChange={(e) => setVariants((v) => ({ ...v, [a.id]: e.target.value }))}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Photos and video</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ImagePlus className="size-3.5" aria-hidden />} Upload
            </Button>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" multiple hidden onChange={(e) => void upload(e.target.files)} />
          </div>
          {uploadError ? <Alert tone="danger" title={uploadError} /> : null}
          {chosenMedia.length ? (
            <ol className="mb-3 flex flex-wrap gap-2">
              {chosenMedia.map((m, i) => (
                <li key={m.id} className="relative">
                  <Thumb asset={m} />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                  <button type="button" aria-label={`Remove ${m.name}`} onClick={() => toggleMedia(m.id)} className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white">
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {assets.length ? (
            <details>
              <summary className="cursor-pointer text-xs text-[color:var(--color-muted-foreground)]">Choose from the media library ({assets.length})</summary>
              <ul className="mt-2 flex max-h-56 flex-wrap gap-2 overflow-y-auto">
                {assets.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => toggleMedia(m.id)} className={`rounded-[var(--radius-md)] ring-2 ${mediaIds.includes(m.id) ? "ring-[var(--color-accent)]" : "ring-transparent"}`} title={m.name}>
                      <Thumb asset={m} />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Campaign" htmlFor="campaignId">
            <Select id="campaignId" name="campaignId" defaultValue={initial.campaignId}>
              <option value="">None</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="When" htmlFor="publishMode" hint="The time is a plan until someone with publishing rights schedules the approved post.">
            <Select id="publishMode" name="publishMode" value={mode} onChange={(e) => setMode(e.target.value === "NOW" ? "NOW" : "SCHEDULE")}>
              <option value="SCHEDULE">At a set time</option>
              <option value="NOW">As soon as it is scheduled</option>
            </Select>
          </Field>
          {mode === "SCHEDULE" ? (
            <>
              <Field label="Date and time" htmlFor="scheduledLocal">
                <Input id="scheduledLocal" name="scheduledLocal" type="datetime-local" defaultValue={initial.scheduledLocal} />
              </Field>
              <Field label="Time zone" htmlFor="timezone">
                <Input id="timezone" name="timezone" list="social-timezones" defaultValue={initial.timezone} />
                <datalist id="social-timezones">
                  {COMMON_TIME_ZONES.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </Field>
            </>
          ) : (
            <input type="hidden" name="timezone" value={initial.timezone} />
          )}
        </div>

        {state.error ? <Alert tone="danger" title={state.error} /> : null}
        {state.success ? <Alert tone="success" title={state.success} /> : null}
        {state.warnings?.length ? (
          <Alert tone="warning" title="Saved, but it cannot be approved until these are fixed:">
            <ul className="list-disc pl-5 text-sm">
              {state.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <Button type="submit" name="intent" value="save" loading={pending}>
            Save draft
          </Button>
          <div className="flex items-end gap-2">
            <Field label="Reviewer (optional)" htmlFor="reviewer">
              <Input id="reviewer" name="reviewer" placeholder="username" className="w-40" />
            </Field>
            <Button type="submit" name="intent" value="submit" variant="primary" loading={pending}>
              Save and send for approval
            </Button>
          </div>
        </div>
      </div>

      <aside className="min-w-0 space-y-3">
        <p className="text-sm font-medium">Preview</p>
        {selected.length === 0 ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Choose an account to see how the post will look there.</p> : null}
        {selected.map((id) => {
          const a = accountById.get(id);
          if (!a || !isSocialPlatform(a.platform)) return null;
          const text = variants[id]?.trim() ? variants[id]! : content;
          const rules = SOCIAL_PLATFORMS[a.platform];
          const problems = validateForPlatform(a.platform, { text, media: chosenMedia.map((m) => ({ kind: m.kind, mimeType: m.mimeType, sizeBytes: m.sizeBytes })) });
          return (
            <div key={id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm shadow-[var(--shadow-xs)]">
              <p className="mb-2 flex items-center justify-between gap-2 text-xs font-medium">
                <span className="truncate">{a.name}</span>
                <span className={`tabular ${[...text].length > rules.maxText ? "text-[color:var(--color-danger)]" : "text-[color:var(--color-muted-foreground)]"}`}>
                  {[...text].length}/{rules.maxText.toLocaleString("en-US")}
                </span>
              </p>
              {chosenMedia.length ? (
                <div className="mb-2 flex gap-1 overflow-x-auto">
                  {chosenMedia.map((m) => (
                    <Thumb key={m.id} asset={m} small />
                  ))}
                </div>
              ) : null}
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{text || <span className="italic text-[color:var(--color-muted-foreground)]">No text</span>}</p>
              {problems.length ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-[color:var(--color-danger)]">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </aside>
    </form>
  );
}

function Thumb({ asset, small }: { asset: ComposerAsset; small?: boolean }) {
  const toProject = useProjectHref();
  const size = small ? "size-14" : "size-20";
  const src = toProject(`/api/social/assets/${asset.id}`);
  return asset.kind === "VIDEO" ? (
    <video src={src} className={`${size} rounded-[var(--radius-md)] bg-black object-cover`} muted preload="metadata" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- served by the project's own checked route
    <img src={src} alt={asset.name} loading="lazy" className={`${size} rounded-[var(--radius-md)] object-cover ring-1 ring-inset ring-[var(--color-border)]`} />
  );
}
