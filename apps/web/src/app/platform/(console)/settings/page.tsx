import NextLink from "next/link";
import { prisma as globalPrisma } from "@support-automation/db";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { EmailSettingsForm } from "./EmailSettingsForm";

export const metadata = { title: "Settings" };

export default async function PlatformSettingsPage() {
  await requireOperatorPage();
  const email = await globalPrisma.platformEmailSettings.findUnique({ where: { id: "default" } });
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" description="Platform-wide settings. Each customer's own software settings are theirs, inside their software." />
      <Card>
        <SectionHeader title="Platform email" description="Sends renewal reminders and owner invitations. Separate from any customer's own email settings." />
        <EmailSettingsForm
          initial={{
            enabled: email?.enabled ?? false,
            host: email?.host ?? "",
            port: email?.port ?? 587,
            tlsMode: email?.tlsMode ?? "STARTTLS",
            username: email?.username ?? "",
            hasPassword: Boolean(email?.passwordCiphertext),
            fromAddress: email?.fromAddress ?? "",
            fromName: email?.fromName ?? "",
            lastTestAt: email?.lastTestAt?.toISOString() ?? null,
            lastTestOk: email?.lastTestOk ?? null,
            lastTestMessage: email?.lastTestMessage ?? null,
            testPending: Boolean(email?.testRequestedAt),
          }}
        />
      </Card>
      <Card>
        <SectionHeader title="Elsewhere" />
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            Addresses, routing and the server IP: <NextLink href="/platform/domains" className="font-medium text-[color:var(--color-accent)] hover:underline">Domains</NextLink>
          </li>
          <li>
            Grace period, reminder days, payment instructions and the default plan:{" "}
            <NextLink href="/platform/plans" className="font-medium text-[color:var(--color-accent)] hover:underline">Plans &amp; billing</NextLink>
          </li>
          <li>
            Who may sign in to the platform: <NextLink href="/platform/operators" className="font-medium text-[color:var(--color-accent)] hover:underline">Operators</NextLink>
          </li>
        </ul>
      </Card>
    </div>
  );
}
