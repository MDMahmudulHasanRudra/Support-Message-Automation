import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { connection } from "next/server";
import { ToastProvider } from "@/components/ui";
import { BrandingProvider } from "@/components/BrandingProvider";
import { accentStyleSheet } from "@/lib/branding";
import { getBranding } from "@/server/branding";
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
      "Rule-based WhatsApp support automation — message triage, escalation timers, and team notifications from one dashboard.",
    applicationName: brand.productName,
    robots: { index: false, follow: false },
    icons: { icon: brand.iconUrl, apple: brand.iconUrl },
  };
}

export const viewport: Viewport = {
  // Both entries so the browser paints its own chrome to match whichever theme
  // the console is actually showing. Matches --color-background in globals.css.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
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
  const brand = await getBranding();
  return (
    <html
      lang="en"
      className={`${sansFace.variable} ${monoFace.variable} h-full antialiased`}
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
          <ToastProvider>{children}</ToastProvider>
        </BrandingProvider>
      </body>
    </html>
  );
}
