"use client";

import { useActionState } from "react";
import { FlaskConical } from "lucide-react";
import {
  Alert,
  Badge,
  type BadgeColor,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Select,
  Switch,
  Textarea,
} from "@/components/ui";
import { testRule, type RuleTesterState } from "@/server/actions/ruleTester";

const initialState: RuleTesterState = {};

export function RuleTesterForm({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const [state, formAction, pending] = useActionState(testRule, initialState);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <SectionHeader title="Simulate a Message" />
        <form action={formAction} className="space-y-4">
          <Field label="Message" required>
            <Textarea name="body" rows={3} required placeholder="e.g. ইন্টারনেট চলছে না" />
          </Field>
          <Field
            label="Simulate at time"
            hint="Leave blank to use the current time. Useful for testing scheduled rules, e.g. overnight windows."
          >
            <Input name="simulateAt" type="datetime-local" />
          </Field>
          <Field label="Sender phone">
            <Input name="senderPhone" defaultValue="+8801000000000" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
            <Switch name="isFromTeamMember" /> Sender is an internal team member
          </label>
          <Field label="Group">
            <Select name="groupId">
              <option value="">(direct message / no group)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Previous sender phone" hint="Optional — used by last-sender rules.">
            <Input name="previousSenderPhone" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-[color:var(--color-foreground)]">
            <Switch name="previousSenderIsTeamMember" /> Previous sender was a team member
          </label>
          <Button type="submit" loading={pending}>
            Run Test (dry — sends nothing)
          </Button>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Result" />
        {state.error ? (
          <div className="mb-4">
            <Alert tone="danger">{state.error}</Alert>
          </div>
        ) : null}
        {state.result ? (
          <div className="space-y-4">
            <div>
              <span className="text-xs text-[color:var(--color-muted-foreground)]">Final Result</span>
              <div className="mt-1">
                <Badge color={state.result.finalDecision === "NO_MATCH" ? "gray" : "blue"}>
                  {state.result.finalDecision}
                </Badge>
              </div>
            </div>
            <div>
              <span className="text-xs text-[color:var(--color-muted-foreground)]">Matched Rule</span>
              <p className="text-sm text-[color:var(--color-foreground)]">
                {state.result.matchedRule
                  ? `${state.result.matchedRule.name} (priority ${state.result.matchedRule.priority})`
                  : "(none — system default applied)"}
              </p>
            </div>
            <div>
              <span className="text-xs text-[color:var(--color-muted-foreground)]">Actions that would execute</span>
              <p className="text-sm text-[color:var(--color-foreground)]">
                {state.result.actions.map((a) => a.type).join(", ") || "(none)"}
              </p>
            </div>
            <div>
              <span className="text-xs text-[color:var(--color-muted-foreground)]">Rules Evaluated</span>
              <ul className="mt-1.5 max-h-80 space-y-2 overflow-y-auto pr-1 text-sm">
                {state.result.trace.map((t, i) => (
                  <li
                    key={i}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[color:var(--color-foreground)]">{t.ruleName}</span>
                      <Badge color={traceColor(t)}>
                        {t.applied ? "APPLIED" : t.matched ? "MATCHED (pre-empted)" : "NO MATCH"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{t.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <EmptyState icon={<FlaskConical className="size-5" aria-hidden />}>
            Run a test to see results here.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

function traceColor(t: { applied: boolean; matched: boolean }): BadgeColor {
  if (t.applied) return "green";
  if (t.matched) return "yellow";
  return "gray";
}
