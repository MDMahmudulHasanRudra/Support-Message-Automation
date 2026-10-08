import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ToastProvider } from "@/components/ui";
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

export const metadata: Metadata = {
  title: {
    default: "Softify Assist",
    template: "%s · Softify Assist",
  },
  description:
    "Rule-based WhatsApp support automation — message triage, escalation timers, and team notifications from one dashboard.",
  applicationName: "Softify Assist",
  robots: { index: false, follow: false },
};

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sansFace.variable} ${monoFace.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
