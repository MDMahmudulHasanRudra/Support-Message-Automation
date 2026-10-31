"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { Check, Copy, Monitor, RotateCcw, Smartphone, Trash2, Upload } from "lucide-react";
import {
  DEFAULT_WIDGET_SETTINGS,
  normalizeOriginInput,
  WIDGET_PRESETS,
  wwwVariant,
  type WidgetPreset,
  type WidgetSettings,
} from "@support-automation/shared";
import { Alert, Button, Field, Input } from "@/components/ui";
import { useProjectHref, useProjectRouter } from "@/components/ProjectLink";
import { removeWidgetAssetAction, rotateWebchatSecretAction, saveWidgetBuilderAction } from "@/server/actions/webchatSettings";
import { CopyValue } from "./ConnectionPanel";

/**
 * The Website Chat Widget Builder (Website Chat V3, docs/website-chat-v3). Controls on one side, the REAL widget on
 * the other: the preview iframe loads the same /api/webchat/widget.js every website loads, in its preview mode —
 * sandboxed, no network, no visitor, nothing sent — and receives the unsaved configuration by postMessage. Saving
 * goes through `saveWidgetBuilderAction`, which re-reads every value on the server. Uploaded images and the team's
 * consent records are managed by their own upload / remove calls, never by this form.
 */

export interface StudioAsset {
  id: string;
  kind: "LOGO" | "ICON" | "AVATAR";
  url: string;
}

export interface StudioInstall {
  seenAt: string | null;
  seenOrigin: string | null;
  seenVersion: string | null;
  refusedAt: string | null;
  refusedOrigin: string | null;
  /** Seen in the last 7 days (decided on the server, not while rendering). */
  seenRecently: boolean;
}

type Section = "general" | "appearance" | "launcher" | "window" | "team" | "behaviour" | "messages" | "hours" | "ai" | "install" | "security" | "analytics";
const SECTIONS: Array<[Section, string]> = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["launcher", "Launcher"],
  ["window", "Chat window"],
  ["team", "Team & avatars"],
  ["behaviour", "Greeting & behaviour"],
  ["messages", "Messages & photos"],
  ["hours", "Business hours"],
  ["ai", "AI & human handoff"],
  ["install", "Installation"],
  ["security", "Security & domains"],
  ["analytics", "Analytics"],
];

/** Fields the builder edits. Assets and team consent are server-held; only the team's order travels. */
type Editable = Omit<WidgetSettings, "assets" | "team">;
const editable = (s: WidgetSettings): Editable => {
  const { assets, team, ...rest } = s;
  void assets;
  void team;
  return rest;
};

const inputClass = "h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px]";
const hint = "text-[11.5px] leading-relaxed text-[color:var(--color-muted-foreground)]";

function luminance(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}
/** WCAG contrast of the text the widget puts on this colour (it picks white or near-black itself). */
function bestContrast(hex: string): number {
  const l = luminance(hex);
  const text = l > 0.45 ? luminance("#0f172a") : 1;
  const [a, b] = l > text ? [l, text] : [text, l];
  return (a + 0.05) / (b + 0.05);
}

export function WidgetStudio(props: {
  connectionId: string;
  widgetKey: string;
  widgetName: string;
  canManage: boolean;
  settings: WidgetSettings;
  origins: string[];
  assets: StudioAsset[];
  scriptUrl: string | null;
  wordpressHref: string | null;
  install: StudioInstall;
  enabled: boolean;
  aiEnabled: boolean;
  hasIdentitySecret: boolean;
  stats: { visitors7d: number; conversations: number; messages7d: number };
  /** The connection's own switches (on/off, AI answers) and rename, rendered by the server page. */
  general: ReactNode;
}) {
  const router = useProjectRouter();
  const [section, setSection] = useState<Section>("general");
  const [s, setS] = useState<Editable>(() => editable(props.settings));
  const [teamOrder, setTeamOrder] = useState(() => props.settings.team.map((m) => m.assetId));
  const [originsText, setOriginsText] = useState(props.origins.join("\n"));
  const [baseline, setBaseline] = useState(() => JSON.stringify({ s: editable(props.settings), o: props.origins.join("\n"), t: props.settings.team.map((m) => m.assetId) }));
  const [result, setResult] = useState<{ error?: string; success?: string }>({});
  const [saving, startSave] = useTransition();
  const dirty = JSON.stringify({ s, o: originsText, t: teamOrder }) !== baseline;

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = <K extends keyof Editable>(key: K, value: Editable[K], appearance = false) => setS((prev) => ({ ...prev, [key]: value, ...(appearance ? { preset: "CUSTOM" as WidgetPreset } : {}) }));
  const team = teamOrder.map((id) => props.settings.team.find((m) => m.assetId === id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const assetUrl = (id: string | null) => props.assets.find((a) => a.id === id)?.url ?? null;

  const save = () =>
    startSave(async () => {
      const r = await saveWidgetBuilderAction(props.connectionId, JSON.stringify({ ...s, teamOrder }), originsText);
      setResult(r);
      if (!r.error) {
        setBaseline(JSON.stringify({ s, o: originsText, t: teamOrder }));
        router.refresh();
      }
    });
  const resetDefaults = () => {
    const d = editable(DEFAULT_WIDGET_SETTINGS);
    // Wording, hours and the websites are the business's own; reset restores the look and behaviour.
    setS({ ...d, title: s.title, welcome: s.welcome, replyNote: s.replyNote, hours: s.hours, offlineMessage: s.offlineMessage, allowPdf: s.allowPdf });
    setResult({});
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
      <div className="min-w-0">
        <nav aria-label="Widget settings" className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1">
          {SECTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              aria-current={section === key ? "page" : undefined}
              className={`shrink-0 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12.5px] font-medium ${section === key ? "bg-[var(--color-primary)] text-[color:var(--color-on-primary)]" : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"}`}
            >
              {label}
            </button>
          ))}
        </nav>

        <fieldset disabled={!props.canManage} className="space-y-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
          {section === "general" ? (
            <>
              {props.general}
              <Field label="Title" htmlFor="title" hint="The heading of the chat window, e.g. your brand or “Customer support”.">
                <Input id="title" value={s.title} maxLength={60} onChange={(e) => set("title", e.target.value)} />
              </Field>
              <Field label="Under the title" htmlFor="replyNote" hint="When people can expect an answer. Empty hides it.">
                <Input id="replyNote" value={s.replyNote} maxLength={120} onChange={(e) => set("replyNote", e.target.value)} />
              </Field>
              <Field label="Welcome message" htmlFor="welcome" hint="The first bubble every visitor sees.">
                <textarea id="welcome" rows={2} value={s.welcome} maxLength={300} onChange={(e) => set("welcome", e.target.value)} className={`${inputClass} h-auto py-2`} />
              </Field>
            </>
          ) : null}

          {section === "appearance" ? (
            <>
              <div>
                <p className="mb-2 text-[12.5px] font-medium">Start from a look</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(Object.keys(WIDGET_PRESETS) as Array<keyof typeof WIDGET_PRESETS>).map((key) => {
                    const p = WIDGET_PRESETS[key];
                    const v = p.values;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setS((prev) => ({ ...prev, ...v, preset: key }))}
                        className={`rounded-[var(--radius-lg)] border p-2 text-left text-[12px] ${s.preset === key ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/30" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}
                      >
                        <span className="mb-1.5 flex h-10 items-end gap-1 rounded-[var(--radius-md)] p-1.5" style={{ background: v.theme === "dark" ? "#16181d" : (v.backgroundColor ?? "#f8fafc") }}>
                          <span className="h-3 w-8 rounded" style={{ background: v.teamBubbleColor ?? "#fff", border: "1px solid #e2e8f0" }} />
                          <span className="ml-auto h-3 w-6 rounded" style={{ background: v.visitorBubbleColor ?? v.color }} />
                          <span className="size-4 rounded-full" style={{ background: v.color }} />
                        </span>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <p className={`${hint} mt-1.5`}>{s.preset === "CUSTOM" ? "Customised — every control below is yours." : "Every value stays editable."}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Theme" htmlFor="theme">
                  <select id="theme" className={inputClass} value={s.theme} onChange={(e) => set("theme", e.target.value as Editable["theme"], true)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="auto">Follow the visitor&apos;s device</option>
                  </select>
                </Field>
                <Field label="Header" htmlFor="headerStyle">
                  <select id="headerStyle" className={inputClass} value={s.headerStyle} onChange={(e) => set("headerStyle", e.target.value as Editable["headerStyle"], true)}>
                    <option value="solid">Solid colour</option>
                    <option value="gradient">Gradient</option>
                    <option value="light">Light with a line</option>
                  </select>
                </Field>
                <Field label="Font" htmlFor="font" hint="System fonts only — nothing is downloaded onto your site.">
                  <select id="font" className={inputClass} value={s.font} onChange={(e) => set("font", e.target.value as Editable["font"], true)}>
                    <option value="system">Clean (system)</option>
                    <option value="rounded">Rounded</option>
                    <option value="humanist">Humanist</option>
                    <option value="serif">Serif</option>
                  </select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ColorField label="Brand colour" value={s.color} onChange={(v) => set("color", v ?? DEFAULT_WIDGET_SETTINGS.color, true)} />
                <ColorField label="Header" value={s.headerColor} auto="Brand colour" onChange={(v) => set("headerColor", v, true)} />
                <ColorField label="Background" value={s.backgroundColor} auto="Theme default" onChange={(v) => set("backgroundColor", v, true)} />
                <ColorField label="Visitor's messages" value={s.visitorBubbleColor} auto="Brand colour" onChange={(v) => set("visitorBubbleColor", v, true)} />
                <ColorField label="Team's messages" value={s.teamBubbleColor} auto="Theme surface" onChange={(v) => set("teamBubbleColor", v, true)} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Range label="Corner roundness" value={s.radius} min={0} max={28} unit="px" onChange={(v) => set("radius", v, true)} />
                <Field label="Shadow" htmlFor="shadow">
                  <select id="shadow" className={inputClass} value={s.shadow} onChange={(e) => set("shadow", e.target.value as Editable["shadow"], true)}>
                    <option value="none">None</option>
                    <option value="soft">Soft</option>
                    <option value="strong">Strong</option>
                  </select>
                </Field>
              </div>
            </>
          ) : null}

          {section === "launcher" ? (
            <>
              <Field label="Button style" htmlFor="launcherStyle">
                <select id="launcherStyle" className={inputClass} value={s.launcherStyle} onChange={(e) => set("launcherStyle", e.target.value as Editable["launcherStyle"])}>
                  <option value="ICON">Round button with an icon</option>
                  <option value="ICON_TEXT">Button with text</option>
                  <option value="LOGO" disabled={!s.logoAssetId}>Your logo{s.logoAssetId ? "" : " (upload one below)"}</option>
                  <option value="CUSTOM_ICON" disabled={!s.launcherAssetId}>Your own icon{s.launcherAssetId ? "" : " (upload one below)"}</option>
                  <option value="AVATAR" disabled={team.length === 0}>Team photos{team.length ? "" : " (add them under Team & avatars)"}</option>
                </select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Icon" htmlFor="launcherIcon">
                  <select id="launcherIcon" className={inputClass} value={s.launcherIcon} onChange={(e) => set("launcherIcon", e.target.value as Editable["launcherIcon"])}>
                    <option value="chat">Chat bubble</option>
                    <option value="message">Round bubble</option>
                    <option value="help">Question mark</option>
                    <option value="headset">Headset</option>
                  </select>
                </Field>
                <Field label="Button text" htmlFor="launcherLabel" hint="Beside the round button, or inside a text button. Hidden on phones.">
                  <Input id="launcherLabel" value={s.launcherLabel} maxLength={30} placeholder="Chat with us" onChange={(e) => set("launcherLabel", e.target.value)} />
                </Field>
                <Range label="Button size" value={s.launcherSize} min={44} max={72} unit="px" onChange={(v) => set("launcherSize", v)} />
                <Field label="Position" htmlFor="position">
                  <select id="position" className={inputClass} value={s.position} onChange={(e) => set("position", e.target.value as Editable["position"])}>
                    <option value="right">Bottom right</option>
                    <option value="left">Bottom left</option>
                  </select>
                </Field>
                <Range label="Distance from the bottom" value={s.bottomOffset} min={0} max={200} unit="px" onChange={(v) => set("bottomOffset", v)} hintText="Raise it above a cookie bar or a bottom menu." />
              </div>
              <AssetSlot
                title="Logo"
                description="Shown on the button (style “Your logo”) and in the chat header. Square works best, at least 128 × 128 px."
                kind="LOGO"
                connectionId={props.connectionId}
                url={assetUrl(s.logoAssetId)}
                assetId={s.logoAssetId}
                canManage={props.canManage}
              />
              <AssetSlot
                title="Your own button icon"
                description="A transparent PNG or WebP icon, drawn on the brand colour."
                kind="ICON"
                connectionId={props.connectionId}
                url={assetUrl(s.launcherAssetId)}
                assetId={s.launcherAssetId}
                canManage={props.canManage}
              />
            </>
          ) : null}

          {section === "window" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Range label="Width on computers" value={s.panelWidth} min={320} max={440} unit="px" onChange={(v) => set("panelWidth", v)} />
                <Range label="Height on computers" value={s.panelHeight} min={420} max={720} unit="px" onChange={(v) => set("panelHeight", v)} hintText="Never taller than the visitor's window." />
              </div>
              <Field label="Beside the title" htmlFor="headerVisual">
                <select id="headerVisual" className={inputClass} value={s.headerVisual} onChange={(e) => set("headerVisual", e.target.value as Editable["headerVisual"])}>
                  <option value="NONE">Nothing</option>
                  <option value="LOGO" disabled={!s.logoAssetId}>Your logo{s.logoAssetId ? "" : " (upload it under Launcher)"}</option>
                  <option value="AVATARS" disabled={team.length === 0}>Team photos and names{team.length ? "" : " (add them under Team & avatars)"}</option>
                </select>
              </Field>
              <Toggle checked={s.mobileFullscreen} onChange={(v) => set("mobileFullscreen", v)} label="Full screen on phones" description="Recommended: the chat covers the page on screens up to 480 px wide, and the page behind it does not scroll." />
            </>
          ) : null}

          {section === "team" ? (
            <TeamSection
              connectionId={props.connectionId}
              canManage={props.canManage}
              team={team}
              assetUrl={assetUrl}
              onOrder={setTeamOrder}
              order={teamOrder}
            />
          ) : null}

          {section === "behaviour" ? (
            <>
              <Range label="Show the button after" value={s.showDelaySec} min={0} max={120} unit="s" onChange={(v) => set("showDelaySec", v)} hintText="0 = as soon as the page loads." />
              <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
                <Toggle checked={s.teaser.enabled} onChange={(v) => set("teaser", { ...s.teaser, enabled: v })} label="Greeting bubble" description="A short message beside the button. Never a fake unread badge, and gone for at least a day once the visitor closes it." />
                {s.teaser.enabled ? (
                  <>
                    <Field label="Greeting" htmlFor="teaserText">
                      <Input id="teaserText" value={s.teaser.text} maxLength={140} onChange={(e) => set("teaser", { ...s.teaser, text: e.target.value })} />
                    </Field>
                    <div className="flex flex-wrap gap-1.5">
                      {["Hi! Need any help?", "Have a question? We're here.", "Ask us about our services."].map((t) => (
                        <button key={t} type="button" onClick={() => set("teaser", { ...s.teaser, text: t })} className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[11.5px] hover:bg-[var(--color-neutral-bg)]">
                          {t}
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Range label="Show after" value={s.teaser.delaySec} min={0} max={300} unit="s" onChange={(v) => set("teaser", { ...s.teaser, delaySec: v })} />
                      <Range label="Show again after" value={s.teaser.capDays} min={0} max={90} unit=" days" onChange={(v) => set("teaser", { ...s.teaser, capDays: v })} hintText="0 = every visit." />
                      <Range label="Hide after" value={s.teaser.hideAfterSec} min={0} max={600} unit="s" onChange={(v) => set("teaser", { ...s.teaser, hideAfterSec: v })} hintText="0 = until closed." />
                    </div>
                    <Toggle checked={s.teaser.oncePerSession} onChange={(v) => set("teaser", { ...s.teaser, oncePerSession: v })} label="At most once per visit" />
                    <Toggle checked={s.teaser.mobile} onChange={(v) => set("teaser", { ...s.teaser, mobile: v })} label="Also on phones" />
                    <p className={hint}>Never shown while the visitor already has a conversation open with you.</p>
                  </>
                ) : null}
              </div>
              <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
                <Toggle checked={s.autoOpen.enabled} onChange={(v) => set("autoOpen", { ...s.autoOpen, enabled: v })} label="Open the chat by itself" description="Off by default. Opens once per visit after the delay, never on phones, and never again after the visitor closes it." />
                {s.autoOpen.enabled ? <Range label="Open after" value={s.autoOpen.delaySec} min={5} max={600} unit="s" onChange={(v) => set("autoOpen", { ...s.autoOpen, delaySec: v })} /> : null}
              </div>
              <div className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
                <Field label="Pages" htmlFor="pagesMode">
                  <select id="pagesMode" className={inputClass} value={s.pages.mode} onChange={(e) => set("pages", { ...s.pages, mode: e.target.value as Editable["pages"]["mode"] })}>
                    <option value="ALL">Every page of the listed websites</option>
                    <option value="INCLUDE">Only these pages</option>
                    <option value="EXCLUDE">Every page except these</option>
                  </select>
                </Field>
                {s.pages.mode !== "ALL" ? (
                  <Field label="Paths" htmlFor="paths" hint="One per line. /pricing = that page only; /blog/* = the blog and everything under it.">
                    <textarea
                      id="paths"
                      rows={3}
                      value={s.pages.paths.join("\n")}
                      onChange={(e) => set("pages", { ...s.pages, paths: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30) })}
                      className={`${inputClass} h-auto py-2 font-mono text-[12px]`}
                    />
                  </Field>
                ) : null}
                <Toggle checked={s.pages.hideCheckout} onChange={(v) => set("pages", { ...s.pages, hideCheckout: v })} label="Hide on checkout, cart and payment pages" />
                <div className="flex flex-wrap gap-4">
                  <Toggle checked={s.devices.desktop} onChange={(v) => set("devices", { ...s.devices, desktop: v || !s.devices.mobile })} label="On computers" />
                  <Toggle checked={s.devices.mobile} onChange={(v) => set("devices", { ...s.devices, mobile: v || !s.devices.desktop })} label="On phones" />
                </div>
              </div>
            </>
          ) : null}

          {section === "messages" ? (
            <>
              <Toggle checked={s.allowAttachments} onChange={(v) => set("allowAttachments", v)} label="Visitors can send photos" description="JPEG, PNG or WebP, up to 10 MB, 10 an hour. Paste, drag or pick; the type is checked from the file itself. No videos." />
              {s.allowAttachments ? (
                <Toggle checked={s.allowPdf} onChange={(v) => set("allowPdf", v)} label="Also PDFs" description="Widgets created before this release kept PDFs switched on; new widgets accept photos only." />
              ) : null}
              <Toggle checked={s.emoji} onChange={(v) => set("emoji", v)} label="Emoji picker" description="Emoji are ordinary text: they always work, this only shows the picker button." />
              <Toggle checked={s.askName} onChange={(v) => set("askName", v)} label="Ask for a name before the first message" description="Optional for the visitor, shown to the team as unverified." />
              <Toggle checked={s.askEmail} onChange={(v) => set("askEmail", v)} label="Ask for an email" description="Optional for the visitor." />
            </>
          ) : null}

          {section === "hours" ? <HoursSection hours={s.hours} offlineMessage={s.offlineMessage} offlineAskEmail={s.offlineAskEmail} onChange={(patch) => setS((prev) => ({ ...prev, ...patch }))} /> : null}

          {section === "ai" ? (
            <div className="space-y-3 text-[12.5px] leading-relaxed">
              <Alert tone={props.aiEnabled ? "info" : "neutral"} title={props.aiEnabled ? "AI answers are on for this widget" : "AI answers are off for this widget"}>
                The switch is under General. Creating a widget never turns AI on.
              </Alert>
              <ul className="list-disc space-y-1.5 pl-5 text-[color:var(--color-muted-foreground)]">
                <li>AI uses this project&apos;s own AI settings, knowledge base and models — the same rules as WhatsApp and the other channels. There is no separate AI or key for the widget.</li>
                <li>It answers only from verified knowledge (under your project&apos;s response mode) and hands over to a person when it cannot.</li>
                <li>A photo is always handed to a person: the AI cannot see images, so it never pretends to.</li>
                <li>As soon as someone from the team replies, AI steps back for the takeover period set in AI Settings.</li>
                <li>Visitors see AI replies labelled “AI assistant”.</li>
              </ul>
            </div>
          ) : null}

          {section === "install" ? (
            <InstallSection scriptUrl={props.scriptUrl} widgetKey={props.widgetKey} wordpressHref={props.wordpressHref} install={props.install} enabled={props.enabled} origins={props.origins} onRecheck={() => router.refresh()} />
          ) : null}

          {section === "security" ? (
            <>
              <OriginsEditor value={originsText} onChange={setOriginsText} />
              <IdentitySecret connectionId={props.connectionId} canManage={props.canManage} hasIdentitySecret={props.hasIdentitySecret} />
            </>
          ) : null}

          {section === "analytics" ? (
            <dl className="grid grid-cols-3 gap-3 text-center">
              {[
                ["Visitors, 7 days", props.stats.visitors7d],
                ["Messages, 7 days", props.stats.messages7d],
                ["Conversations, all time", props.stats.conversations],
              ].map(([label, n]) => (
                <div key={label as string} className="rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] p-3">
                  <dt className="text-[11.5px] text-[color:var(--color-muted-foreground)]">{label}</dt>
                  <dd className="mt-0.5 text-[18px] font-semibold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </fieldset>

        {props.canManage ? (
          <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-3 shadow-[var(--shadow-sm)] backdrop-blur">
            <span className={`text-[12.5px] ${dirty ? "font-medium text-[color:var(--color-warning-fg)]" : "text-[color:var(--color-muted-foreground)]"}`}>{dirty ? "Unsaved changes" : "All changes saved"}</span>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={resetDefaults}>
                <RotateCcw className="size-3.5" aria-hidden />
                Reset look to defaults
              </Button>
              <Button type="button" size="sm" loading={saving} disabled={!dirty} onClick={save}>
                Save and apply
              </Button>
            </div>
            {result.error ? <div className="w-full"><Alert tone="danger" title={result.error} /></div> : null}
            {result.success && !dirty ? <p className="w-full text-[12px] text-[color:var(--color-success-fg)]">{result.success}</p> : null}
          </div>
        ) : null}
      </div>

      <WidgetPreview settings={s} team={team} assetUrl={assetUrl} widgetName={props.widgetName} widgetKey={props.widgetKey} />
    </div>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────────────────────────

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const SAMPLE = () => [
  { id: "s1", from: "visitor", text: "Hi! Do you deliver to Chattogram? 🚚", at: minutesAgo(9), attachments: [] },
  { id: "s2", from: "team", author: "Rina", text: "Yes — anywhere in Bangladesh, usually in 2–3 days 😊", at: minutesAgo(8), attachments: [] },
  { id: "s3", from: "visitor", text: "ধন্যবাদ! This is the one I mean:", at: minutesAgo(3), attachments: [{ index: 0, type: "IMAGE", name: "product.jpg" }] },
  { id: "s4", from: "ai", text: "Thanks! That item is in stock. Someone from the team will confirm the delivery date shortly.", at: minutesAgo(2), attachments: [] },
];

function WidgetPreview({ settings, team, assetUrl, widgetName, widgetKey }: { settings: Editable; team: Array<{ assetId: string; name: string }>; assetUrl: (id: string | null) => string | null; widgetName: string; widgetKey: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [open, setOpen] = useState(true);
  const [offline, setOffline] = useState(false);
  const [teaser, setTeaser] = useState(false);
  const [sample, setSample] = useState(true);
  const [typing, setTyping] = useState(false);
  const [darkSite, setDarkSite] = useState(false);

  const config = useMemo(
    () => ({
      name: widgetName,
      enabled: true,
      settings: {
        ...settings,
        hours: undefined,
        logoUrl: assetUrl(settings.logoAssetId),
        launcherIconUrl: assetUrl(settings.launcherAssetId),
        team: team.map((m) => ({ name: m.name, avatarUrl: assetUrl(m.assetId) })).filter((m) => m.avatarUrl),
      },
      availability: offline ? { open: false, nextOpen: "tomorrow 09:00" } : { open: true, nextOpen: null },
    }),
    [settings, team, assetUrl, widgetName, offline],
  );
  const post = () => frame.current?.contentWindow?.postMessage({ type: "getassist-preview", config, messages: sample ? SAMPLE() : [], view: { open, teaser, typing } }, "*");
  useEffect(() => {
    const t = setTimeout(post, 120);
    return () => clearTimeout(t);
  });

  // A stand-in website, so the widget is seen over a page. The widget itself is the real script.
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif;background:${darkSite ? "#0b0d12" : "#ffffff"};color:${darkSite ? "#e5e7eb" : "#111827"}}header{padding:18px 22px;border-bottom:1px solid ${darkSite ? "#222" : "#eee"};font-weight:700}main{padding:28px 22px;max-width:640px}h1{font-size:26px;margin:0 0 10px}.l{height:10px;border-radius:5px;background:${darkSite ? "#1f2937" : "#f1f5f9"};margin:10px 0}</style></head><body><header>Your website</header><main><h1>Welcome to our shop</h1><div class="l" style="width:92%"></div><div class="l" style="width:80%"></div><div class="l" style="width:86%"></div><div class="l" style="width:60%"></div></main>` +
      // Relative on purpose: a srcdoc document resolves against this page's address, and the same string renders on the
      // server and the client (an origin read from window made the server and client markup differ).
      `<script src="/api/webchat/widget.js" data-key="${widgetKey.replace(/[^A-Za-z0-9_-]/g, "")}" data-preview="1"></script></body></html>`,
    [widgetKey, darkSite],
  );
  const chip = (on: boolean) => `rounded-[var(--radius-md)] px-2 py-1 text-[11.5px] font-medium ${on ? "bg-[var(--color-primary)] text-[color:var(--color-on-primary)]" : "border border-[var(--color-border)] text-[color:var(--color-muted-foreground)]"}`;

  return (
    <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={chip(device === "desktop")} onClick={() => setDevice("desktop")} aria-pressed={device === "desktop"}>
          <Monitor className="inline size-3.5" aria-hidden /> Computer
        </button>
        <button type="button" className={chip(device === "mobile")} onClick={() => setDevice("mobile")} aria-pressed={device === "mobile"}>
          <Smartphone className="inline size-3.5" aria-hidden /> Phone
        </button>
        <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
        <button type="button" className={chip(open)} onClick={() => setOpen(!open)} aria-pressed={open}>{open ? "Open" : "Closed"}</button>
        <button type="button" className={chip(offline)} onClick={() => setOffline(!offline)} aria-pressed={offline}>{offline ? "Away" : "Online"}</button>
        <button type="button" className={chip(teaser)} onClick={() => { setTeaser(!teaser); setOpen(false); }} aria-pressed={teaser}>Greeting</button>
        <button type="button" className={chip(sample)} onClick={() => setSample(!sample)} aria-pressed={sample}>Sample chat</button>
        <button type="button" className={chip(typing)} onClick={() => setTyping(!typing)} aria-pressed={typing}>Typing</button>
        <button type="button" className={chip(darkSite)} onClick={() => setDarkSite(!darkSite)} aria-pressed={darkSite}>Dark site</button>
      </div>
      <div className={`overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] ${device === "mobile" ? "mx-auto w-[390px] max-w-full" : "w-full"}`}>
        <iframe
          ref={frame}
          title="Widget preview — nothing is sent"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          onLoad={post}
          className="block w-full border-0"
          style={{ height: device === "mobile" ? 720 : 680 }}
        />
      </div>
      <p className={`${hint} mt-1.5`}>The real widget, with your unsaved changes. Nothing typed here is sent, and no visitor is created.</p>
    </div>
  );
}

// ── Small controls ───────────────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex items-start gap-2.5 text-[12.5px]">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-[color:var(--color-foreground)]">{label}</span>
        {description ? <span className={`${hint} block`}>{description}</span> : null}
      </span>
    </label>
  );
}

function Range({ label, value, min, max, unit, onChange, hintText }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void; hintText?: string }) {
  return (
    <label className="block text-[12.5px]">
      <span className="mb-1 flex justify-between font-medium">
        {label}
        <span className="tabular-nums text-[color:var(--color-muted-foreground)]">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--color-primary)]" />
      {hintText ? <span className={hint}>{hintText}</span> : null}
    </label>
  );
}

function ColorField({ label, value, onChange, auto }: { label: string; value: string | null; onChange: (v: string | null) => void; auto?: string }) {
  const contrast = value ? bestContrast(value) : null;
  return (
    <div className="text-[12.5px]">
      <span className="mb-1 block font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <input type="color" value={value ?? "#2563eb"} onChange={(e) => onChange(e.target.value)} aria-label={label} className="h-9 w-12 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]" />
        <Input value={value ?? ""} placeholder={auto ?? ""} maxLength={7} onChange={(e) => onChange(/^#[0-9a-fA-F]{6}$/.test(e.target.value) ? e.target.value.toLowerCase() : e.target.value === "" && auto ? null : value)} className="w-28 font-mono" aria-label={`${label} hex code`} />
        {auto && value ? (
          <button type="button" onClick={() => onChange(null)} className="text-[11.5px] text-[color:var(--color-muted-foreground)] underline">
            Use {auto.toLowerCase()}
          </button>
        ) : null}
      </div>
      {contrast !== null && contrast < 4.5 ? <span className="mt-1 block text-[11.5px] text-[color:var(--color-warning-fg)]">Text on this colour is hard to read (contrast {contrast.toFixed(1)}:1, aim for 4.5:1).</span> : null}
    </div>
  );
}

function AssetSlot({ title, description, kind, connectionId, url, assetId, canManage }: { title: string; description: string; kind: "LOGO" | "ICON"; connectionId: string; url: string | null; assetId: string | null; canManage: boolean }) {
  const router = useProjectRouter();
  const toProject = useProjectHref();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const upload = (file: File) =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      const r = await fetch(toProject(`/api/webchat/brand/${connectionId}`), { method: "POST", body: form }).catch(() => null);
      const j = (await r?.json().catch(() => null)) as { error?: string } | null;
      if (!r?.ok) setError(j?.error ?? "The image was not uploaded. Try again.");
      else router.refresh();
    });
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
      <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- the widget's own public brand image */}
        {url ? <img src={url} alt="" className="size-full object-contain" /> : <Upload className="size-5 text-[color:var(--color-subtle-foreground)]" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1 text-[12.5px]">
        <p className="font-medium">{title}</p>
        <p className={hint}>{description} JPEG, PNG or WebP, up to 512 KB.</p>
        {error ? <p className="mt-1 text-[11.5px] text-[color:var(--color-danger-fg)]">{error}</p> : null}
        {canManage ? (
          <div className="mt-2 flex gap-2">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>
              {url ? "Replace" : "Upload"}
            </Button>
            {assetId ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => start(async () => { const r = await removeWidgetAssetAction(connectionId, assetId); if (r.error) setError(r.error); else router.refresh(); })}>
                <Trash2 className="size-3.5" aria-hidden />
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TeamSection({ connectionId, canManage, team, assetUrl, order, onOrder }: { connectionId: string; canManage: boolean; team: Array<{ assetId: string; name: string; consentBy: string; consentAt: string }>; assetUrl: (id: string | null) => string | null; order: string[]; onOrder: (o: string[]) => void }) {
  const router = useProjectRouter();
  const toProject = useProjectHref();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const add = () =>
    start(async () => {
      setError(null);
      if (!chosen) return setError("Choose a photo first.");
      const form = new FormData();
      form.append("file", chosen);
      form.append("kind", "AVATAR");
      form.append("name", name);
      form.append("consent", consent ? "yes" : "no");
      const r = await fetch(toProject(`/api/webchat/brand/${connectionId}`), { method: "POST", body: form }).catch(() => null);
      const j = (await r?.json().catch(() => null)) as { error?: string } | null;
      if (!r?.ok) return setError(j?.error ?? "The photo was not added. Try again.");
      setName("");
      setConsent(false);
      setChosen(null);
      router.refresh();
    });
  return (
    <div className="space-y-4 text-[12.5px]">
      <p className={hint}>
        Up to five people, shown in the chat header or on the button. Only photos you add here are ever shown — nothing is read from staff records. The widget never shows anyone as “online”: nothing here knows who is.
      </p>
      {team.length ? (
        <ul className="space-y-2">
          {team.map((m, i) => (
            <li key={m.assetId} className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- an approved public team photo */}
              <img src={assetUrl(m.assetId) ?? ""} alt="" className="size-10 rounded-full object-cover" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{m.name}</span>
                <span className={hint}>Consent confirmed by {m.consentBy}, {new Date(m.consentAt).toLocaleDateString()}</span>
              </span>
              {canManage ? (
                <>
                  <button type="button" disabled={i === 0} onClick={() => onOrder(swap(order, i, i - 1))} className="rounded px-1.5 text-[color:var(--color-muted-foreground)] disabled:opacity-30" aria-label={`Move ${m.name} up`}>↑</button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => start(async () => { const r = await removeWidgetAssetAction(connectionId, m.assetId); if (r.error) setError(r.error); else router.refresh(); })}>
                    <Trash2 className="size-3.5" aria-hidden />
                    <span className="sr-only">Remove {m.name}</span>
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage && team.length < 5 ? (
        <div className="space-y-2.5 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-3">
          <p className="font-medium">Add a team member</p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => setChosen(e.target.files?.[0] ?? null)} />
            <Button type="button" size="sm" variant="secondary" onClick={() => file.current?.click()}>
              <Upload className="size-3.5" aria-hidden />
              {chosen ? chosen.name : "Choose a photo"}
            </Button>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name visitors see, e.g. Rina" className="max-w-56" aria-label="Team member's name" />
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            <span>This person agreed to their photo and name being shown publicly on our website. (Recorded with your name and the date.)</span>
          </label>
          {error ? <p className="text-[11.5px] text-[color:var(--color-danger-fg)]">{error}</p> : null}
          <Button type="button" size="sm" loading={busy} disabled={!chosen || !name.trim() || !consent} onClick={add}>
            Add to the widget
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const swap = (list: string[], a: number, b: number) => {
  const next = list.slice();
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
};

/** Saturday first, as the week is read here; the stored list stays Sunday-first (index = JS weekday). */
const HOURS_DAY_ORDER: ReadonlyArray<[number, string]> = [
  [6, "Saturday"],
  [0, "Sunday"],
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
];

function HoursSection({ hours, offlineMessage, offlineAskEmail, onChange }: { hours: WidgetSettings["hours"]; offlineMessage: string; offlineAskEmail: boolean; onChange: (patch: Partial<Editable>) => void }) {
  const setDay = (index: number, value: { open: string; close: string } | null) => onChange({ hours: { ...hours, days: hours.days.map((d, i) => (i === index ? value : d)) } });
  return (
    <div className="space-y-3 text-[12.5px]">
      <Toggle checked={hours.enabled} onChange={(v) => onChange({ hours: { ...hours, enabled: v } })} label="Business hours" description="Outside them the widget shows the team as away and when it is back. Visitors can always write; nothing is refused." />
      {hours.enabled ? (
        <>
          <Field label="Time zone" htmlFor="tz" hint="An IANA name, like Asia/Dhaka or Europe/London.">
            <Input id="tz" value={hours.timezone} maxLength={60} onChange={(e) => onChange({ hours: { ...hours, timezone: e.target.value } })} />
          </Field>
          <div className="space-y-1.5">
            {HOURS_DAY_ORDER.map(([index, label]) => {
              const day = hours.days[index];
              return (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 shrink-0">{label}</span>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={!day} onChange={(e) => setDay(index, e.target.checked ? null : { open: "09:00", close: "18:00" })} /> Closed
                  </label>
                  {day ? (
                    <>
                      <input type="time" value={day.open} onChange={(e) => setDay(index, { ...day, open: e.target.value })} aria-label={`${label} opens`} className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
                      <span aria-hidden>–</span>
                      <input type="time" value={day.close} onChange={(e) => setDay(index, { ...day, close: e.target.value })} aria-label={`${label} closes`} className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
                      {day.open >= day.close ? <span className="text-[11.5px] text-[color:var(--color-danger-fg)]">Closing must be after opening.</span> : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
          <Field label="Away message" htmlFor="offlineMessage">
            <Input id="offlineMessage" value={offlineMessage} maxLength={300} onChange={(e) => onChange({ offlineMessage: e.target.value })} />
          </Field>
          <Toggle checked={offlineAskEmail} onChange={(v) => onChange({ offlineAskEmail: v })} label="While away, ask for an email so the team can answer later" />
        </>
      ) : null}
    </div>
  );
}

export function OriginsEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lines = value.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
  const read = lines.map((line) => ({ line, origin: normalizeOriginInput(line) }));
  const origins = read.map((r) => r.origin).filter((o): o is string => Boolean(o));
  const offers = [...new Set(origins.map(wwwVariant).filter((o): o is string => Boolean(o) && !origins.includes(o as string)))];
  return (
    <div className="space-y-2 text-[12.5px]">
      <Field label="Websites it runs on" htmlFor="origins" required hint="One per line. A domain like getassist.pro is enough — it is read as https://getassist.pro. The widget refuses every other site.">
        <textarea id="origins" rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} h-auto py-2 font-mono text-[12px]`} />
      </Field>
      {read.length ? (
        <ul className="space-y-1">
          {read.map((r) => (
            <li key={r.line} className={`flex items-center gap-1.5 ${r.origin ? "text-[color:var(--color-muted-foreground)]" : "text-[color:var(--color-danger-fg)]"}`}>
              {r.origin ? <Check className="size-3.5 text-[color:var(--color-success-fg)]" aria-hidden /> : <span aria-hidden>✕</span>}
              {r.origin ? (r.origin === r.line ? r.origin : `${r.line} → will be saved as ${r.origin}`) : `${r.line} — not a website address (use example.com or https://www.example.com)`}
            </li>
          ))}
        </ul>
      ) : null}
      {offers.map((o) => (
        <p key={o} className="flex flex-wrap items-center gap-2">
          <span className={hint}>Does your site also open as {o}?</span>
          <button type="button" className="text-[12px] font-medium underline" onClick={() => onChange(`${value.trim()}\n${o}`)}>
            Add {o} too
          </button>
        </p>
      ))}
    </div>
  );
}

function IdentitySecret({ connectionId, canManage, hasIdentitySecret }: { connectionId: string; canManage: boolean; hasIdentitySecret: boolean }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 border-t border-[var(--color-border)] pt-4 text-[12.5px]">
      <p className="font-medium">Signed-in customers (optional)</p>
      <p className={hint}>
        To show a logged-in customer as verified, your SERVER computes <code>HMAC-SHA256(identity secret, user id)</code> as hex and the page sets, before the script:
      </p>
      <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-2.5 text-[11.5px]">{`<script>window.GetAssistChat = { user: { id: "123", name: "Rina", email: "rina@example.com", hash: "<hmac hex>",
  phone: "01712345678", phoneHash: "<HMAC-SHA256(secret, \"phone:123:01712345678\") hex>" } };</script>`}</pre>
      <p className={hint}>Never put the secret in a page or in the browser. Without a valid hash the visitor is anonymous and anything they type is shown as unverified. The WordPress plugin does this for you.</p>
      {secret ? <CopyValue label="Identity secret — shown once" value={secret} /> : null}
      {error ? <Alert tone="danger" title={error} /> : null}
      {canManage ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={pending}
          onClick={() =>
            start(async () => {
              const r = await rotateWebchatSecretAction(connectionId);
              if (r.error) setError(r.error);
              else setSecret(r.secret ?? null);
            })
          }
        >
          {hasIdentitySecret ? "Replace identity secret" : "Create identity secret"}
        </Button>
      ) : null}
      {hasIdentitySecret && !secret ? <p className={hint}>A secret exists. Replacing it stops the old one verifying anybody.</p> : null}
    </div>
  );
}

// ── Installation ─────────────────────────────────────────────────────────────────────────────────

type Platform = "html" | "wordpress" | "shopify" | "react" | "next" | "webflow" | "wix" | "other";
const PLATFORMS: Array<[Platform, string]> = [
  ["html", "HTML"],
  ["wordpress", "WordPress"],
  ["shopify", "Shopify"],
  ["react", "React"],
  ["next", "Next.js"],
  ["webflow", "Webflow"],
  ["wix", "Wix"],
  ["other", "Other"],
];

function InstallSection({ scriptUrl, widgetKey, wordpressHref, install, enabled, origins, onRecheck }: { scriptUrl: string | null; widgetKey: string; wordpressHref: string | null; install: StudioInstall; enabled: boolean; origins: string[]; onRecheck: () => void }) {
  const [platform, setPlatform] = useState<Platform>("html");
  const [copied, setCopied] = useState(false);
  if (!scriptUrl) return <Alert tone="warning" title="This server's public address (NEXTAUTH_URL) is not set, so the install code cannot be built." />;
  const snippet = `<script src="${scriptUrl}" data-key="${widgetKey}" async></script>`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const fresh = install.seenRecently;
  const steps: Record<Platform, ReactNode> = {
    html: <p>Paste the code just before <code>&lt;/body&gt;</code> on every page (or in your shared footer template).</p>,
    wordpress: (
      <div className="space-y-2">
        <p>Easiest: download the plugin below → Plugins → Add New → Upload Plugin → Activate. It adds the chat to every page, with a switch to hide it and per-page exclusions. Or paste the code with any “insert footer code” plugin.</p>
        {wordpressHref ? (
          <a href={wordpressHref} download className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium hover:bg-[var(--color-neutral-bg)]">
            Download WordPress plugin
          </a>
        ) : null}
      </div>
    ),
    shopify: <p>Online Store → Themes → ⋯ → Edit code → layout/theme.liquid → paste the code just before <code>&lt;/body&gt;</code> → Save. List your shop&apos;s address (and the myshopify.com one, if customers use it) under Security &amp; domains.</p>,
    react: <p>In your root component, add the script once (e.g. in <code>useEffect</code>: create a <code>script</code> element with <code>src</code>, <code>data-key</code> and <code>async</code>, and append it to <code>document.body</code>). It survives route changes by itself.</p>,
    next: <p>In <code>app/layout.tsx</code>, inside <code>&lt;body&gt;</code>: <code>{`<Script src="${scriptUrl}" data-key="${widgetKey}" strategy="afterInteractive" />`}</code> (from <code>next/script</code>). Client-side navigation is followed automatically.</p>,
    webflow: <p>Site settings → Custom code → Footer code → paste the code → Save and publish. (Custom code needs a paid Webflow site plan.)</p>,
    wix: <p>Settings → Custom code → Add custom code → paste the code, load it on all pages, place it in “Body – end” → Apply. (Needs a Wix premium plan with a connected domain.)</p>,
    other: <p>Any builder that lets you add an external script to the page footer works: paste the code there. If yours only allows iframes or blocks external scripts, the widget cannot run on it.</p>,
  };
  return (
    <div className="space-y-4 text-[12.5px]">
      <div>
        <p className="mb-1.5 font-medium">Your install code</p>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[12px]">{snippet}</code>
          <Button type="button" size="sm" onClick={copy} aria-live="polite">
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
        <p className={`${hint} mt-1`}>The same line works everywhere and never changes: you design the widget here, the website keeps the line. It holds no secret.</p>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap gap-1">
          {PLATFORMS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setPlatform(key)} className={`rounded-[var(--radius-md)] px-2 py-1 text-[12px] ${platform === key ? "bg-[var(--color-neutral-bg)] font-semibold" : "text-[color:var(--color-muted-foreground)]"}`} aria-pressed={platform === key}>
              {label}
            </button>
          ))}
        </div>
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3 leading-relaxed text-[color:var(--color-muted-foreground)]">{steps[platform]}</div>
      </div>
      <div className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">Verify installation</p>
          <Button type="button" size="sm" variant="secondary" onClick={onRecheck}>
            Check again
          </Button>
        </div>
        <ul className="space-y-1.5">
          <Status ok={Boolean(install.seenAt)} text={install.seenAt ? `The widget started on ${install.seenOrigin} — last ${new Date(install.seenAt).toLocaleString()}${install.seenVersion ? ` (script ${install.seenVersion})` : ""}.` : "Not detected yet. Open your website in a browser after adding the code, then check again."} />
          {install.seenAt && !fresh ? <Status ok={false} text="Not seen in the last 7 days — has the code been removed, or the site moved?" /> : null}
          <Status ok={enabled} text={enabled ? "The widget is switched on." : "The widget is switched off (General): visitors see “Chat is not available right now”."} />
          <Status ok={origins.length > 0} text={origins.length ? `Allowed websites: ${origins.join(", ")}.` : "No website is listed under Security & domains."} />
          {install.refusedOrigin ? <Status ok={false} text={`${install.refusedOrigin} tried to start the widget (${install.refusedAt ? new Date(install.refusedAt).toLocaleString() : ""}) but is not listed. If it is your site, add it under Security & domains.`} /> : null}
        </ul>
        <details className="text-[color:var(--color-muted-foreground)]">
          <summary className="cursor-pointer font-medium text-[color:var(--color-foreground)]">Troubleshooting</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Nothing appears: check the address in the browser bar matches a listed website exactly (https, with or without www).</li>
            <li>Your site sends a Content-Security-Policy: allow this app&apos;s address in <code>script-src</code>, <code>connect-src</code> and <code>img-src</code>.</li>
            <li>The site is http:// only: the widget needs https (localhost is allowed for testing).</li>
            <li>An ad or script blocker can hide it for some visitors; that is their browser&apos;s choice.</li>
            <li>Page rules (Greeting &amp; behaviour) can hide it on some pages, and it never shows on checkout pages unless you allow it.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}

function Status({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${ok ? "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)]" : "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)]"}`} aria-hidden>
        {ok ? "✓" : "!"}
      </span>
      <span>{text}</span>
    </li>
  );
}
