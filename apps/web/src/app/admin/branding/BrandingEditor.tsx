"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ImageUp, RotateCcw, Trash2 } from "lucide-react";
import { BrandMark, Button, Card, Field, Input, SectionHeader, Textarea, useToast } from "@/components/ui";
import {
  removeBrandAsset,
  saveBranding,
  uploadBrandAsset,
  type BrandAssetState,
  type BrandingFormState,
} from "@/server/actions/branding";
import { BRANDING_LIMITS, contrastOnWhite, normalizeAccentColor, type BrandAssetKind } from "@/lib/branding";

interface Settings {
  productName: string | null;
  loginHeadline: string | null;
  loginSubheading: string | null;
  accentColor: string | null;
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

/** The built-in accent (globals.css `--color-accent`), shown when no brand colour is set. */
const DEFAULT_ACCENT = "#4f46e5";

/**
 * The Branding form and its live preview. Text fields are empty when the built-in wording is in use
 * (it is shown as the placeholder), so "clear the field and save" is Reset — the same rule the
 * server applies, which also stores the default text itself as "use the default".
 */
export function BrandingEditor({ canManage, defaults, settings }: { canManage: boolean; defaults: Defaults; settings: Settings }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [productName, setProductName] = useState(settings.productName ?? "");
  const [loginHeadline, setLoginHeadline] = useState(settings.loginHeadline ?? "");
  const [loginSubheading, setLoginSubheading] = useState(settings.loginSubheading ?? "");
  const [accent, setAccent] = useState(settings.accentColor ?? "");
  const [state, formAction, pending] = useActionState(saveBranding, {} as BrandingFormState);

  useEffect(() => {
    if (!state.savedAt) return;
    showToast({ tone: "success", title: "Branding saved", description: "Every page now shows it." });
    router.refresh();
  }, [state.savedAt, showToast, router]);

  const shownName = productName.trim() || defaults.productName;
  const shownHeadline = loginHeadline.trim() || defaults.loginHeadline;
  const parsedAccent = normalizeAccentColor(accent);
  const accentHex = "value" in parsedAccent && parsedAccent.value ? parsedAccent.value : null;
  const lowContrast = accentHex ? contrastOnWhite(accentHex) < 3 : false;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <Card>
          <SectionHeader
            title="Name and sign-in page"
            description="Leave a field empty to use the built-in text, shown greyed out in it."
          />
          <form action={formAction} className="space-y-4">
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
            <Field
              label="Brand colour"
              htmlFor="accentColor"
              error={state.fieldErrors?.accentColor}
              hint={
                lowContrast
                  ? "This colour is very light: links and highlights in it will be hard to read on a white page. A darker shade works better."
                  : "Links, the active menu item, highlights and focus rings. Buttons and the sidebar keep their dark ink, so text always stays readable."
              }
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the brand colour"
                  value={accentHex ?? DEFAULT_ACCENT}
                  onChange={(e) => setAccent(e.target.value)}
                  disabled={!canManage}
                  className="h-9.5 w-12 shrink-0 cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1 disabled:cursor-not-allowed"
                />
                <Input
                  id="accentColor"
                  name="accentColor"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder={`${DEFAULT_ACCENT} (built-in)`}
                  maxLength={7}
                  className="max-w-[12rem] font-mono"
                  disabled={!canManage}
                />
                {accent && canManage ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccent("")}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    Built-in colour
                  </Button>
                ) : null}
              </div>
            </Field>
            {state.error ? <p className="text-[13px] font-medium text-[color:var(--color-danger)]">{state.error}</p> : null}
            {canManage ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={pending}>
                  Save
                </Button>
                {settings.updatedAt ? (
                  <span className="text-[12px] text-[color:var(--color-muted-foreground)]" suppressHydrationWarning>
                    Last changed {new Date(settings.updatedAt).toLocaleString()}
                    {settings.updatedByUsername ? ` by ${settings.updatedByUsername}` : ""}
                  </span>
                ) : null}
              </div>
            ) : null}
          </form>
        </Card>

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

      <aside className="min-w-0 xl:sticky xl:top-0 xl:self-start">
        <Card>
          <SectionHeader title="Preview" description="How it will look once saved." />
          <Preview name={shownName} headline={shownHeadline} accent={accentHex ?? DEFAULT_ACCENT} logoUrl={settings.logoUrl} iconUrl={settings.iconUrl} />
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
                  onClick={() =>
                    startRemoving(async () => {
                      const result = await removeBrandAsset(kind);
                      if (result.error) showToast({ tone: "danger", title: result.error });
                      else {
                        showToast({ tone: "success", title: `${title} removed` });
                        router.refresh();
                      }
                    })
                  }
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Remove
                </Button>
              ) : null}
            </form>
            <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
              PNG, JPEG, WebP, GIF, ICO or SVG, up to {BRANDING_LIMITS.assetBytes / 1024} KB.
            </p>
            {localError || state.error ? (
              <p className="text-[12px] font-medium text-[color:var(--color-danger)]">{localError ?? state.error}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** The two places the brand is most visible: the sidebar header and the sign-in panel. */
function Preview({ name, headline, accent, logoUrl, iconUrl }: { name: string; headline: string; accent: string; logoUrl: string | null; iconUrl: string | null }) {
  const mark = iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- the uploaded icon served by our own route
    <img src={iconUrl} alt="" className="size-8 shrink-0 rounded-[var(--radius-md)] object-contain" />
  ) : (
    // No icon uploaded: the built-in mark, exactly as the sidebar draws it.
    <BrandMark className="size-8" />
  );
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">Sidebar</p>
        <div className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3">
          {mark}
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-[color:var(--color-foreground)]">Main Admin</span>
            <span className="block truncate text-[11px] text-[color:var(--color-muted-foreground)]">{name}</span>
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="rounded-[var(--radius-sm)] px-2 py-1 font-medium" style={{ color: accent, background: `color-mix(in oklab, ${accent} 10%, transparent)` }}>
            Active menu item
          </span>
          <span className="underline" style={{ color: accent }}>
            A link
          </span>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">Sign-in page</p>
        <div className="rounded-[var(--radius-md)] bg-[#0b0b0d] p-4 text-[#fafafa]">
          {logoUrl ? (
            <span className="inline-flex max-w-full items-center rounded-[var(--radius-sm)] bg-white px-2 py-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded logo served by our own route */}
              <img src={logoUrl} alt={name} className="h-5 w-auto max-w-full object-contain" />
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {mark}
              <span className="text-[13px] font-semibold">{name}</span>
            </span>
          )}
          <p className="mt-3 text-[15px] font-semibold leading-snug [text-wrap:balance]">{headline}</p>
          <p className="mt-3 text-[10px] text-white/40">© {new Date().getFullYear()} {name}</p>
        </div>
      </div>
    </div>
  );
}
