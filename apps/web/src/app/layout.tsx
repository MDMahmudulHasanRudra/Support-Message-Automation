import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Support Message Automation",
    template: "%s · Support Automation",
  },
  description:
    "Rule-based WhatsApp support automation — message triage, escalation timers, and team notifications from one dashboard.",
  applicationName: "Support Message Automation",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  // Both entries so the browser paints its own chrome to match whichever theme
  // the console is actually showing.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f6" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
