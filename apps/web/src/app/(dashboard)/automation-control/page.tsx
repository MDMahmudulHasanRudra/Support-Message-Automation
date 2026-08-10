import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { setAutomationEnabled, setAutomationMode } from "@/server/actions/settings";

const MODES = [
  { value: "MANUAL_ONLY", label: "Manual Only", description: "Detects and notifies only. No automatic replies." },
  { value: "SAFE_AUTO_REPLY", label: "Safe Auto Reply (recommended)", description: "Only vetted acknowledgement rules may reply." },
  { value: "FULL_RULE_AUTOMATION", label: "Full Rule Automation", description: "All active rules may execute, subject to rate limits." },
] as const;

export default async function AutomationControlPage() {
  await requireSession();
  const settings = await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  return (
    <div>
      <PageHeader title="Automation Control" description="The global emergency switch and automation level." />

      <Card className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Kill Switch</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              When paused: no new automatic replies are sent. Incoming messages are still stored and the support team is
              still notified.
            </p>
          </div>
          <Badge color={settings.automationEnabled ? "green" : "red"}>
            {settings.automationEnabled ? "ENABLED" : "PAUSED"}
          </Badge>
        </div>
        <div className="mt-4">
          {settings.automationEnabled ? (
            <form action={setAutomationEnabled.bind(null, false)}>
              <Button variant="danger" type="submit">Pause Automation</Button>
            </form>
          ) : (
            <form action={setAutomationEnabled.bind(null, true)}>
              <Button type="submit">Resume Automation</Button>
            </form>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Automation Mode</h2>
        <div className="space-y-3">
          {MODES.map((mode) => (
            <div
              key={mode.value}
              className={`flex items-center justify-between rounded-md border p-3 ${
                settings.mode === mode.value
                  ? "border-zinc-900 dark:border-zinc-100"
                  : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <div>
                <p className="text-sm font-medium">{mode.label}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{mode.description}</p>
              </div>
              {settings.mode === mode.value ? (
                <Badge color="blue">Current</Badge>
              ) : (
                <form action={setAutomationMode.bind(null, mode.value)}>
                  <Button variant="secondary" type="submit">Select</Button>
                </form>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
