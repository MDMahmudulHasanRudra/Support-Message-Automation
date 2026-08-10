"use client";

import { useActionState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { testRule, type RuleTesterState } from "@/server/actions/ruleTester";

const initialState: RuleTesterState = {};
const inputClass = "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export function RuleTesterForm({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const [state, formAction, pending] = useActionState(testRule, initialState);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Simulate a Message</h2>
        <form action={formAction} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Message</label>
            <textarea name="body" rows={3} required className={inputClass} placeholder="e.g. ইন্টারনেট চলছে না" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Sender phone</label>
            <input name="senderPhone" defaultValue="+8801000000000" className={inputClass} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isFromTeamMember" /> Sender is an internal team member
          </label>
          <div>
            <label className="mb-1 block text-sm font-medium">Group</label>
            <select name="groupId" className={inputClass}>
              <option value="">(direct message / no group)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Previous sender phone (optional)</label>
            <input name="previousSenderPhone" className={inputClass} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="previousSenderIsTeamMember" /> Previous sender was a team member
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Testing..." : "Run Test (dry — sends nothing)"}
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Result</h2>
        {state.error ? <p className="text-sm text-red-600">{state.error}</p> : null}
        {state.result ? (
          <div className="space-y-4">
            <div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Final Result</span>
              <div className="mt-1">
                <Badge color={state.result.finalDecision === "NO_MATCH" ? "gray" : "blue"}>
                  {state.result.finalDecision}
                </Badge>
              </div>
            </div>
            <div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Matched Rule</span>
              <p className="text-sm">
                {state.result.matchedRule
                  ? `${state.result.matchedRule.name} (priority ${state.result.matchedRule.priority})`
                  : "(none — system default applied)"}
              </p>
            </div>
            <div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Actions that would execute</span>
              <p className="text-sm">{state.result.actions.map((a) => a.type).join(", ") || "(none)"}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Rules Evaluated</span>
              <ul className="mt-1 max-h-80 space-y-2 overflow-y-auto text-sm">
                {state.result.trace.map((t, i) => (
                  <li key={i} className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{t.ruleName}</span>
                      <Badge color={t.applied ? "green" : t.matched ? "yellow" : "gray"}>
                        {t.applied ? "APPLIED" : t.matched ? "MATCHED (pre-empted)" : "NO MATCH"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Run a test to see results here.</p>
        )}
      </Card>
    </div>
  );
}
