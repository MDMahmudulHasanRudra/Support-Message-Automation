import type { ReactNode } from "react";
import { getBranding } from "@/server/branding";
import Link from "next/link";

/** The public pages (SIGNUP.md): the pricing page and sign-up. No session and no project. */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const brand = await getBranding();
  return (
    <div className="min-h-dvh bg-[var(--color-background)]">
      <header className="bg-[linear-gradient(120deg,#08414b_0%,#0d6a74_100%)] text-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/pricing" className="text-[17px] font-semibold tracking-[-0.01em]">
            {brand.productName}
          </Link>
          <Link href="/login" className="text-[13.5px] font-medium text-white/85 hover:text-white">
            Sign in
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
