import { notFound, redirect } from "next/navigation";
import NextLink from "next/link";
import { DEFAULT_PRODUCT_NAME, hostServesPlatform } from "@support-automation/shared";
import { prisma as globalPrisma } from "@support-automation/db";
import { currentHostScope } from "@/server/hostScope";
import { getOperator } from "@/server/platform/auth";
import { PlatformLoginForm } from "./PlatformLoginForm";

export const metadata = { title: "Sign in" };

export default async function PlatformLoginPage() {
  if (!hostServesPlatform(await currentHostScope())) notFound();
  if (await getOperator()) redirect("/platform");
  const operators = await globalPrisma.platformOperator.count();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-[color:var(--color-subtle-foreground)] uppercase">{DEFAULT_PRODUCT_NAME} Platform</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[color:var(--color-foreground)]">Sign in</h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          For the people who run {DEFAULT_PRODUCT_NAME}. Customers sign in on their own address.
        </p>
        <div className="mt-6">
          {operators === 0 ? (
            <p className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
              The platform has no operator yet.{" "}
              <NextLink href="/platform/setup" className="font-medium text-[color:var(--color-accent)] hover:underline">
                Set it up
              </NextLink>
              .
            </p>
          ) : (
            <PlatformLoginForm />
          )}
        </div>
      </div>
    </main>
  );
}
