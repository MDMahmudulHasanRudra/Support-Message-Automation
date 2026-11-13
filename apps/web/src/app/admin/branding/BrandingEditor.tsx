"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ImageUp, RotateCcw, Trash2 } from "lucide-react";
import { Badge, BrandMark, Button, Card, ConfirmDialog, Field, Input, SectionHeader, Textarea, useToast } from "@/components/ui";
import {
  removeBrandAsset,
  saveBranding,
  uploadBrandAsset,
  type BrandAssetState,
  type BrandingFormState,
} from "@/server/actions/branding";
import { BRANDING_LIMITS, contrastOnWhite, normalizeAccentColor, type BrandAssetKind } from "@/lib/branding";
import { DEFAULT_THEME_PALETTE, themePalette, type ThemePalette, type ThemePaletteId } from "@/lib/themes";
import { PalettePicker } from "@/components/theme/PalettePicker";

interface Settings {
  productName: string | null;
  loginHeadline: string | null;
  loginSubheading: string | null;
  accentColor: string | null;
  themePalette: ThemePaletteId | null;
  logoUrl: string | null;
  iconUrl: string | null;
  updatedAt: string | null;
  updatedByUsername: string | null;
}

interface Defaults {
  productName: string;
  loginHeadline: string;
  loginSubheading: string;
}

/**
 * The Branding form and its live preview. Text fields are empty when the built-in wording is in use
 * (it is shown as the placeholder), so "clear the field and save" is Reset — the same rule the
 * server applies, which also stores the default text itself as "use the default". The default theme
 * is part of the same form (a hidden field), so one Save covers everything above the images.
 */
export function BrandingEditor({ canManage, defaults, settings }: { canManage: boolean; defaults: Defaults; settings: Settings }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [productName, setProductName] = useState(settings.productName ?? "");
  const [loginHeadline, setLoginHeadline] = useState(settings.loginHeadline ?? "");
  const [loginSubheading, setLoginSubheading] = useState(settings.loginSubheading ?? "");
  const [accent, setAccent] = useState(settings.accentColor ?? "");
  const [palette, setPalette] = useState<ThemePaletteId>(settings.themePalette ?? DEFAULT_THEME_PALETTE);
  const [state, formAction, pending] = useActionState(saveBranding, {} as BrandingFormState);

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: "Branding saved", description: "Every page now shows it." });
    router.refresh();
  }, [state.savedAt, showToast, router]);

  const chosen = themePalette(palette);
  const shownName = productName.trim() || defaults.productName;
  const shownHeadline = loginHeadline.trim() || defaults.loginHeadline;
  const shownSubheading = loginSubheading.trim() || defaults.loginSubheading;
  const parsedAccent = normalizeAccentColor(accent);
  const accentHex = "value" in parsedAccent && parsedAccent.value ? parsedAccent.value : null;
  const lowContrast = accentHex ? contrastOnWhite(accentHex) < 3 : false;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-6">
        <form action={formAction} className="space-y-6">
          <input type="hidden" name="themePalette" value={palette} />
          <Card>
            <SectionHeader
              title="Default theme"
              description="The colours everybody sees until they pick their own under My account → Appearance. People who already chose a theme keep theirs."
              action={<Badge color="gray">{chosen.name}</Badge>}
            />
            <PalettePicker
              label="Default theme"
              value={palette}
              onChange={(next) => {
                if (next !== "default") setPalette(next);
              }}
              disabled={!canManage}
            />
            {state.fieldErrors?.themePalette ? (
              <p role="alert" className="mt-3 text-[12px] font-medium text-[color:var(--color-danger)]">
                {state.fieldErrors.themePalette}
              </p>
            ) : null}
          </Card>

          <Card>
            <SectionHeader title="Name and sign-in page" description="Leave a field empty to use the built-in text, shown greyed out in it." />
            <div className="space-y-4">
              <Field
                label="Product name"
                htmlFor="productName"
                error={state.fieldErrors?.productName}
                hint="Shown in the browser tab, the sidebar, the sign-in page and by the AI assistant."
              >
                <Input
                  id="productName"
                  name="productName"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder={defaults.productName}
                  maxLength={BRANDING_LIMITS.productName}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Sign-in headline" htmlFor="loginHeadline" error={state.fieldErrors?.loginHeadline}>
                <Input
                  id="loginHeadline"
                  name="loginHeadline"
                  value={loginHeadline}
                  onChange={(e) => setLoginHeadline(e.target.value)}
                  placeholder={defaults.loginHeadline}
                  maxLength={BRANDING_LIMITS.loginHeadline}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Sign-in text" htmlFor="loginSubheading" error={state.fieldErrors?.loginSubheading} hint="The paragraph under the headline.">
                <Textarea
                  id="loginSubheading"
                  name="loginSubheading"
                  value={loginSubheading}
                  onChange={(e) => setLoginSubheading(e.target.value)}
                  placeholder={defaults.loginSubheading}
                  maxLength={BRANDING_LIMITS.loginSubheading}
                  className="min-h-20"
                  disabled={!canManage}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <SectionHeader
              title="Brand colour"
              description="Optional. Replaces the theme's accent for everybody, whichever theme they use: links, the active menu item, highlights and focus rings."
            />
            <Field
              label="Colour"
              htmlFor="accentColor"
              error={state.fieldErrors?.accentColor}
              hint={
                lowContrast
                  ? "This colour is very light: links and highlights in it will be hard to read on a white page. A darker shade works better."
                  : "Buttons keep their dark ink, so text always stays readable. Leave it empty to use the theme's own accent."
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the brand colour"
                  value={accentHex ?? chosen.swatch.accent}
                  onChange={(e) => setAccent(e.target.value)}
                  disabled={!canManage}
                  className="h-9.5 w-12 shrink-0 cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1 disabled:cursor-not-allowed"
                />
                <Input
                  id="accentColor"
                  name="accentColor"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder={`${chosen.swatch.accent} (theme)`}
                  maxLength={7}
                  className="max-w-[12rem] font-mono"
                  disabled={!canManage}
                />
                {accent && canManage ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccent("")}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    Use the theme&rsquo;s colour
                  </Button>
                ) : null}
              </div>
            </Field>
          </Card>

          {state.error ? (
            <p role="alert" className="text-[13px] font-medium text-[color:var(--color-danger)]">
              {state.error}
            </p>
          ) : null}
          {canManage ? (
            <div className="sticky bottom-3 z-[var(--z-sticky)] flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-4 py-3 shadow-[var(--shadow-md)] backdrop-blur">
              <Button type="submit" loading={pending}>
                Save branding
              </Button>
              {settings.updatedAt ? (
                <span className="text-[12px] text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                  Last changed {new Date(settings.updatedAt).toLocaleString()}
                  {settings.updatedByUsername ? ` by ${settings.updatedByUsername}` : ""}
                </span>
              ) : (
                <span className="text-[12px] text-[color:var(--color-muted-foreground)]">Using the built-in brand.</span>
              )}
            </div>
          ) : null}
        </form>

        <div className="grid gap-6 2xl:grid-cols-2">
          <AssetCard
            kind="logo"
            title="Logo"
            description="A wide logo (wordmark) for the sign-in page. Use a transparent PNG or an SVG, about 4 times as wide as it is tall. Without one, the sign-in page shows the app icon and the product name."
            url={settings.logoUrl}
            canManage={canManage}
          />
          <AssetCard
            kind="icon"
            title="App icon"
            description="A square icon for the sidebar and the browser tab (favicon). Use a square PNG or SVG, at least 256 × 256. Without one, the built-in mark is used."
            url={settings.iconUrl}
            canManage={canManage}
          />
        </div>
      </div>

      <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <Card className="overflow-hidden p-0">
          <div className="px-5 pt-5">
            <SectionHeader title="Live preview" description="How it looks once saved. Nothing changes until you press Save." />
          </div>
          <Preview
            palette={chosen}
            accentOverride={accentHex}
            name={shownName}
            headline={shownHeadline}
            subheading={shownSubheading}
            logoUrl={settings.logoUrl}
            iconUrl={settings.iconUrl}
          />
        </Card>
      </aside>
    </div>
  );
}

function AssetCard({
  kind,
  title,
  description,
  url,
  canManage,
}: {
  kind: BrandAssetKind;
  title: string;
  description: string;
  url: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [removing, startRemoving] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [state, formAction, pending] = useActionState(
    (prev: BrandAssetState, formData: FormData) => uploadBrandAsset(kind, prev, formData),
    {} as BrandAssetState,
  );

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: `${title} uploaded` });
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }, [state.savedAt, showToast, router, title]);

  return (
    <Card>
      <SectionHeader title={title} description={description} />
      <div className="flex flex-wrap items-start gap-4">
        {/* The icon is seen on light and dark sidebars, so it is previewed on both. The logo is only
            ever shown on a white plate (the sign-in page), so it is previewed there alone. */}
        <div className="flex gap-2">
          {(kind === "logo" ? (["light"] as const) : (["light", "dark"] as const)).map((tone) => (
            <div
              key={tone}
              className={`flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] ${
                kind === "logo" ? "h-20 w-48 px-3" : "size-20"
              } ${tone === "light" ? "bg-white" : "bg-[#0b0b0d]"}`}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element -- the uploaded image served by our own route
                <img src={url} alt={`${title} on a ${tone} background`} className={kind === "logo" ? "max-h-12 max-w-full object-contain" : "size-12 rounded-[var(--radius-md)] object-contain"} />
              ) : (
                <span className={`text-[11px] ${tone === "light" ? "text-[#64748b]" : "text-[#94a3b8]"}`}>{kind === "logo" ? "No logo" : "Built-in"}</span>
              )}
            </div>
          ))}
        </div>

        {canManage ? (
          <div className="min-w-0 flex-1 space-y-2">
            <form
              action={formAction}
              onSubmit={(event) => {
                const file = fileRef.current?.files?.[0];
                if (!file) {
                  event.preventDefault();
                  setLocalError("Choose an image file first.");
                } else if (file.size > BRANDING_LIMITS.assetBytes) {
                  event.preventDefault();
                  setLocalError(`That file is ${Math.ceil(file.size / 1024)} KB. The limit is ${BRANDING_LIMITS.assetBytes / 1024} KB.`);
                } else {
                  setLocalError(null);
                }
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                ref={fileRef}
                type="file"
                name="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/svg+xml,.ico"
                aria-label={`${title} file`}
                onChange={(e) => {
                  setChosen(e.target.files?.[0]?.name ?? null);
                  setLocalError(null);
                }}
                className="max-w-full text-[12px] text-[color:var(--color-muted-foreground)] file:mr-3 file:cursor-pointer file:rounded-[var(--radius-md)] file:border file:border-[var(--color-border-strong)] file:bg-[var(--color-surface)] file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-[color:var(--color-foreground)]"
              />
              <Button type="submit" size="sm" loading={pending} disabled={!chosen}>
                <ImageUp className="size-3.5" aria-hidden />
                Upload
              </Button>
              {url ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={removing}
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Remove
                </Button>
              ) : null}
            </form>
            <ConfirmDialog
              open={confirmRemove}
              onClose={() => setConfirmRemove(false)}
              onConfirm={() =>
                startRemoving(async () => {
                  const result = await removeBrandAsset(kind);
                  setConfirmRemove(false);
                  if (result.error) showToast({ tone: "danger", title: result.error });
                  else {
                    showToast({ tone: "success", title: `${title} removed` });
                    router.refresh();
                  }
                })
              }
              title={`Remove the ${title.toLowerCase()}?`}
              description={
                kind === "logo"
                  ? "The uploaded logo is deleted and the sign-in page goes back to the built-in mark and product name, for everyone. To use it again, upload the file again."
                  : "The uploaded icon is deleted and the built-in mark is shown again wherever the icon appeared, for everyone. To use it again, upload the file again."
              }
              confirmLabel={`Remove ${title.toLowerCase()}`}
              tone="danger"
              loading={removing}
            />
            <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
              PNG, JPEG, WebP, GIF, ICO or SVG, up to {BRANDING_LIMITS.assetBytes / 1024} KB.
            </p>
            {localError || state.error ? (
              <p role="alert" className="text-[12px] font-medium text-[color:var(--color-danger)]">
                {localError ?? state.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The places the brand is most visible: the console (deep field, sidebar, the sheet with a button and
 * a link) and the sign-in panel, drawn in the chosen theme with the brand colour on top when one is
 * set — mixed the same way accentStyleSheet (lib/branding.ts) mixes it on the real pages.
 */
function Preview({
  palette,
  accentOverride,
  name,
  headline,
  subheading,
  logoUrl,
  iconUrl,
}: {
  palette: ThemePalette;
  accentOverride: string | null;
  name: string;
  headline: string;
  subheading: string;
  logoUrl: string | null;
  iconUrl: string | null;
}) {
  const s = palette.swatch;
  const accent = accentOverride ?? s.accent;
  const field = accentOverride ? `color-mix(in oklab, ${accentOverride} 26%, #04181d)` : s.field;
  const active = accentOverride ? `color-mix(in oklab, ${accentOverride} 62%, #083138)` : s.active;
  const mark = accentOverride ? `color-mix(in oklab, ${accentOverride} 62%, white)` : s.mark;
  const icon = iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- the uploaded icon served by our own route
    <img src={iconUrl} alt="" className="size-7 shrink-0 rounded-[var(--radius-sm)] object-contain" />
  ) : (
    // No icon uploaded: the built-in mark, exactly as the sidebar draws it.
    <BrandMark className="size-7" />
  );
  const label = "mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-subtle-foreground)]";
  return (
    <div className="space-y-5 px-5 pb-5">
      <div>
        <p className={label}>Workspace</p>
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] shadow-[var(--shadow-sm)]" style={{ background: field }}>
          <div className="flex items-center gap-2 px-3 py-2.5">
            {icon}
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-white">{name}</span>
            <span aria-hidden className="h-5 w-16 shrink-0 rounded-full bg-white/10" />
          </div>
          <div className="flex">
            <div className="w-[34%] shrink-0 space-y-1 px-2 pb-3 pt-1">
              <span className="flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[11px] font-medium text-white" style={{ background: active }}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: mark }} />
                Inbox
              </span>
              {["Contacts", "Reports", "Settings"].map((item) => (
                <span key={item} className="block truncate px-2 py-1 text-[11px] text-white/65">
                  {item}
                </span>
              ))}
            </div>
            <div className="min-w-0 flex-1 rounded-tl-[12px] p-3" style={{ background: s.sheet }}>
              <div className="rounded-[8px] border border-black/[0.06] bg-white p-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.05)]">
                <p className="truncate text-[11px] font-semibold text-[#0f172a]">Waiting for a reply</p>
                <p className="mt-0.5 text-[10px] text-[#64748b]">3 conversations</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-[5px] px-2 py-1 text-[10px] font-medium text-white" style={{ background: s.primary }}>
                    Open inbox
                  </span>
                  <span className="text-[10px] font-medium underline underline-offset-2" style={{ color: accent }}>
                    View all
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <p className={label}>Sign-in page</p>
        <div className="rounded-[var(--radius-lg)] p-4 text-white shadow-[var(--shadow-sm)]" style={{ background: field }}>
          {logoUrl ? (
            <span className="inline-flex max-w-full items-center rounded-[var(--radius-sm)] bg-white px-2 py-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded logo served by our own route */}
              <img src={logoUrl} alt={name} className="h-5 w-auto max-w-full object-contain" />
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              {icon}
              <span className="truncate text-[13px] font-semibold">{name}</span>
            </span>
          )}
          <p className="mt-4 text-[16px] font-semibold leading-snug tracking-[-0.01em] [text-wrap:balance] [overflow-wrap:anywhere]">{headline}</p>
          <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-white/70 [overflow-wrap:anywhere]">{subheading}</p>
          <span aria-hidden className="mt-3 block h-1 w-10 rounded-full" style={{ background: mark }} />
        </div>
      </div>
    </div>
  );
}
