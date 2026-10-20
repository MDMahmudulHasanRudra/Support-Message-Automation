"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Eye } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { previewTeamMemberIdentityChange, type IdentityPreviewRequest, type IdentityPreviewResponse } from "@/server/actions/identityPreview";

/**
 * "Preview impact" for a team-member identity change (unified reporting, UNIFIED_REPORTING).
 *
 * READ-ONLY: it asks the server what would be attributed differently and prints counts, never a
 * message. Saving stays the form's own Save button; this only carries what the person saw (a digest
 * and the counts) as hidden fields, which Save records beside the System Log entry. It never blocks
 * Save: a preview is advisory, and a roster fix must not wait on a report computation.
 *
 * Rendered INSIDE the form it previews and reads that form's fields by name.
 */

const STALE_AFTER_MS = 10 * 60_000;

const LABEL_WORDS: Record<string, string> = {
  CUSTOMER: "Customer",
  STAFF_UNIDENTIFIED: "Staff, not matched to one person",
  BUSINESS: "Business number",
};

const KPI_LABELS: Record<string, string> = {
  customerMessages: "Customer messages",
  memberReplies: "Team replies",
  businessReplies: "Business-number replies",
  waits: "Customer waits",
  missed: "Missed",
  recalled: "Recalled",
  unrecovered: "Never answered",
  unattributedStaffReplies: "Staff replies credited to nobody",
  overtimeSeconds: "Support Overtime (seconds)",
  verifiedEmployeeReplies: "Verified employee replies",
  firstHumanAnsweredVerified: "Human waits answered by a verified employee",
};

type Ok = Extract<IdentityPreviewResponse, { ok: true }>;

export function IdentityImpactPanel({
  memberId,
  linkSenderId,
  newMemberLabel = "the new member",
}: {
  /** The member being edited; null on the add form. The chat link form takes it from its own select. */
  memberId: string | null;
  /** WhatsApp Chat's link form: the sender id being linked. */
  linkSenderId?: string;
  newMemberLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Ok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [changed, setChanged] = useState(false);
  const [old, setOld] = useState(false);

  const formOf = () => root.current?.closest("form") ?? null;

  // The digest describes the values that were previewed: editing a field afterwards drops it.
  useEffect(() => {
    const form = formOf();
    if (!form) return;
    const onChange = () => setChanged(true);
    form.addEventListener("input", onChange);
    form.addEventListener("change", onChange);
    return () => {
      form.removeEventListener("input", onChange);
      form.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    if (at === null) return;
    const timer = window.setInterval(() => setOld(Date.now() - at > STALE_AFTER_MS), 15_000);
    return () => window.clearInterval(timer);
  }, [at]);

  function buildRequest(): IdentityPreviewRequest | null {
    const form = formOf();
    if (!form) return null;
    const data = new FormData(form);
    if (linkSenderId !== undefined) {
      const chosen = String(data.get("memberId") ?? "").trim();
      if (!chosen) {
        setError("Choose a team member first.");
        return null;
      }
      return { memberId: chosen, proposed: null, linkSenderId };
    }
    return {
      memberId,
      proposed: {
        phoneNumber: String(data.get("phoneNumber") ?? ""),
        whatsappId: String(data.get("whatsappId") ?? "").trim() || null,
        ...(data.has("attributeFrom") ? { attributeFrom: String(data.get("attributeFrom") ?? "").trim() || null } : {}),
      },
    };
  }

  function run() {
    setError(null);
    const request = buildRequest();
    if (!request) return;
    start(async () => {
      const response = await previewTeamMemberIdentityChange(request);
      if (!response.ok) {
        setResult(null);
        setError(response.error);
        return;
      }
      setResult(response);
      setAt(Date.now());
      setChanged(false);
      setOld(false);
    });
  }

  const fresh = result !== null && !changed;
  const nameOf = (label: string): string => {
    if (!label.startsWith("MEMBER:")) return LABEL_WORDS[label] ?? label;
    const id = label.slice("MEMBER:".length);
    return id === result?.newMemberId ? newMemberLabel : (result?.memberNames[id] ?? "A team member");
  };
  const when = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });

  return (
    <div ref={root} className="space-y-2" data-testid="identity-impact-panel">
      <Button type="button" size="sm" variant="secondary" loading={pending} onClick={run}>
        <Eye className="size-3.5" aria-hidden />
        Preview impact
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result ? (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-[13px]">
          <p className="font-medium">Impact on stored history. Read-only: nothing has been changed.</p>
          {changed ? <Alert tone="warning">The form changed after this preview. Preview again to see the current effect.</Alert> : null}
          {old && !changed ? <Alert tone="warning">This preview is older than 10 minutes. Preview again.</Alert> : null}
          {result.preview.truncated ? (
            <Alert tone="warning">There are more matching messages than the preview reads, so these are the most recent ones only.</Alert>
          ) : null}
          {result.preview.affected.logicalMessages === 0 ? (
            <p>
              No stored message from {when(result.preview.window.from)} to {when(result.preview.window.to)} would be attributed differently.
            </p>
          ) : (
            <>
              <p>
                {result.preview.affected.logicalMessages.toLocaleString("en-US")} message{result.preview.affected.logicalMessages === 1 ? "" : "s"} in{" "}
                {result.preview.affected.groups.toLocaleString("en-US")} group{result.preview.affected.groups === 1 ? "" : "s"}
                {result.showPersonal ? ` and ${result.preview.affected.personalConversations.toLocaleString("en-US")} personal chat${result.preview.affected.personalConversations === 1 ? "" : "s"}` : ""}{" "}
                from {when(result.preview.window.from)} to {when(result.preview.window.to)} would be attributed differently.
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {result.preview.transitions.map((t) => (
                  <li key={`${t.from}|${t.to}`}>
                    {nameOf(t.from)} to {nameOf(t.to)}: {t.count.toLocaleString("en-US")}
                  </li>
                ))}
              </ul>
              {result.preview.byMember.length ? (
                <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                  {result.preview.byMember.map((m) => `${nameOf(`MEMBER:${m.memberId}`)}: +${m.gained} / -${m.lost}`).join("; ")}
                </p>
              ) : null}
              {result.preview.impactedMonths.length ? (
                <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                  Months affected: {result.preview.impactedMonths.map((m) => `${m.month} (${m.changed})`).join(", ")}
                </p>
              ) : null}
              {result.kpi ? (
                <div className="overflow-x-auto">
                  <p className="mb-1 text-[12px] font-medium">Estimate for {result.kpi.month}, the {result.kpi.groupsConsidered} most affected group{result.kpi.groupsConsidered === 1 ? "" : "s"} only</p>
                  <table className="w-full text-left text-[12px]">
                    <thead>
                      <tr>
                        <th className="pr-3 font-medium">Figure</th>
                        <th className="pr-3 font-medium">Now</th>
                        <th className="font-medium">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.kpi.group, ...(result.kpi.personal ?? []).map((p) => ({ ...p, field: `personal:${p.field}` }))]
                        .filter((row) => row.before !== row.after)
                        .map((row) => (
                          <tr key={row.field}>
                            <td className="pr-3">{row.field.startsWith("personal:") ? `Personal, ${KPI_LABELS[row.field.slice(9)]?.toLowerCase()}` : KPI_LABELS[row.field]}</td>
                            <td className="pr-3">{row.before.toLocaleString("en-US")}</td>
                            <td>{row.after.toLocaleString("en-US")}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Reports change immediately; stored stamps, Activity Feed and Duty History follow within a few minutes (history sync).
          </p>
          {fresh ? (
            <>
              <input type="hidden" name="previewDigest" value={result.digest} />
              <input type="hidden" name="previewAffected" value={result.preview.affected.logicalMessages} />
              <input type="hidden" name="previewGroups" value={result.preview.affected.groups} />
              <input type="hidden" name="previewPersonal" value={result.preview.affected.personalConversations} />
              <input type="hidden" name="previewFrom" value={new Date(result.preview.window.from).toISOString()} />
              <input type="hidden" name="previewTo" value={new Date(result.preview.window.to).toISOString()} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
