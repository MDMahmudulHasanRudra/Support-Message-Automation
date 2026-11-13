import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { Inter, JetBrains_Mono } from "next/font/google";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { ToastProvider } from "@/components/ui";
import { BrandingProvider } from "@/components/BrandingProvider";
import { NavigationProgress } from "@/components/NavigationProgress";
import { accentStyleSheet } from "@/lib/branding";
import { getBranding } from "@/server/branding";
import { getSession } from "@/server/auth";
import { PALETTE_COOKIE, resolvePalette } from "@/lib/themes";
import "./globals.css";

// Inter (headline/body) + JetBrains Mono (labels, tabular data) — the console's
// enterprise typography system. Both load through next/font/google exactly like
// the fonts they replace, so this is a font swap, not a new dependency.
const sansFace = Inter({
  variable: "--font-sans-face",
  subsets: ["latin"],
});

const monoFace = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
});

/**
 * The title, the app name and the tab icon come from the installation's brand (BRANDING.md), so a
 * Main Admin renaming the product or uploading an icon changes every page. `connection()` keeps
 * this per request: built once at `next build`, the brand would be frozen at whatever the build
 * machine read — or at the default, since a build has no database.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const brand = await getBranding();
  return {
    title: {
      default: brand.productName,
      template: `%s · ${brand.productName}`,
    },
    description:
      "Every customer conversation in one place: WhatsApp, Messenger, Instagram, Telegram and website chat, answered by your team and AI.",
    applicationName: brand.productName,
    robots: { index: false, follow: false },
    icons: { icon: brand.iconUrl, apple: brand.hasCustomIcon ? brand.iconUrl : "/app-icon-192.png" },
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: brand.productName, statusBarStyle: "default" },
  };
}

export const viewport: Viewport = {
  // Both entries so the browser paints its own chrome to match whichever theme
  // the console is actually showing. Matches --color-background in globals.css.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#083138" },
    { media: "(prefers-color-scheme: dark)", color: "#083138" },
  ],
};

// Applies the stored theme choice before first paint, so an explicitly-dark user
// never gets a white flash on load. Deliberately tiny, synchronous, and wrapped
// in try/catch — blocked storage must not break rendering.
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("sa-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  const [brand, session, cookieStore] = await Promise.all([getBranding(), getSession().catch(() => null), cookies()]);
  // The colour theme (lib/themes.ts), rendered on the server so there is no flash: the person's own
  // choice (carried by the session row, no extra query), else this device's cookie when signed out,
  // else the installation's default. Every value is checked against the catalogue before it is used.
  const palette = resolvePalette({
    signedIn: Boolean(session),
    personal: session?.themePalette,
    cookie: cookieStore.get(PALETTE_COOKIE)?.value,
    installationDefault: brand.themePalette,
  });
  return (
    <html
      lang="en"
      className={`${sansFace.variable} ${monoFace.variable} h-full antialiased`}
      data-palette={palette}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {/* The brand colour, when a Main Admin set one: a validated #rrggbb, so nothing else can
            reach this style sheet. */}
        {brand.accentColor ? <style dangerouslySetInnerHTML={{ __html: accentStyleSheet(brand.accentColor) }} /> : null}
      </head>
      <body className="min-h-full flex flex-col">
        <BrandingProvider value={brand}>
          <Suspense fallback={null}>
            <NavigationProgress />
          </Suspense>
          <ToastProvider>{children}</ToastProvider>
          <ServiceWorkerRegistrar />
        </BrandingProvider>
      </body>
    </html>
  );
}
