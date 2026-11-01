import type { Metadata } from "next";
import NextLink from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandMark, Button } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { getBranding } from "@/server/branding";
import { hasPermission } from "@/server/permissions";
import { logout } from "@/server/actions/session";

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = await getBranding();
  return { title: `My account · ${productName}` };
}

/**
 * My account outside every project (ACCOUNT_SELF_SERVICE.md), for every signed-in person. A Main Admin
 * also has it inside the portal at /admin/account; this one needs nothing but a session.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const [brand, portal] = await Promise.all([getBranding(), hasPermission(session, "projects.view")]);
  return (
    <div className="min-h-dvh bg-[var(--color-background)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-7 shrink-0" />
            <span className="truncate text-sm font-semibold">{brand.productName}</span>
          </div>
          <div className="flex items-center gap-2">
            <NextLink href="/open" className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
              <ArrowLeft className="size-4" aria-hidden />
              <span>Back to workspace</span>
            </NextLink>
            {portal ? (
              <NextLink href="/admin" className="hidden rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] sm:inline">
                Main Admin
              </NextLink>
            ) : null}
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="px-4 py-8 sm:py-10">{children}</main>
    </div>
  );
}
