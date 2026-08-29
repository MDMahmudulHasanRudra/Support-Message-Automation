"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { Badge, EmptyState, Table, Td, Th } from "@/components/ui";

export interface AiActivityRow {
  id: string;
  timeLabel: string;
  outcome: "AI_REPLIED" | "HUMAN_FALLBACK";
  /** Short diagnostic code, only meaningful on a handoff. */
  reason: string | null;
  intent: string | null;
  confidenceScore: number | null;
  customerMessage: string;
  messageId: string;
  groupId: string | null;
  groupName: string | null;
  senderLabel: string;
  responseText: string | null;
  providerName: string | null;
  modelId: string | null;
  tokensUsed: number | null;
  /** Set when the AI's reply was actually queued — links the decision to what was sent. */
  outboundStatus: string | null;
}

/**
 * Plain-language explanations for the diagnostic codes runAiFallback writes. The code itself is
 * still shown, because it is what appears in logs and support conversations — but nobody should
 * have to read the source to find out what LOW_CONFIDENCE meant for a given message.
 */
const REASON_HELP: Record<string, string> = {
  AI_UNAVAILABLE: "No AI provider is configured for the RESPONSE job, or the AI engine is off.",
  NO_KNOWLEDGE:
    "Nothing verified covers this, and the response mode is Strict — so nothing was answered.",
  NO_BUSINESS_KNOWLEDGE:
    "This asks about your business specifically, and no verified knowledge covers it. AI never guesses your company's answer, whatever the response mode.",
  LOW_CONFIDENCE_GENERAL:
    "A general question the AI could have answered, but below the bar set for answers with no verified knowledge behind them.",
  LOW_CONFIDENCE: "The AI answered, but below your confidence threshold, so it was not sent.",
  AI_DECLINED: "The AI judged that this needs a person, and chose not to answer.",
  EMPTY_RESPONSE: "The AI said it would reply but returned nothing usable.",
  MALFORMED_RESPONSE: "The AI's answer did not follow the requested format and could not be trusted.",
};

function explainReason(reason: string | null): string | null {
  if (!reason) return null;
  if (REASON_HELP[reason]) return REASON_HELP[reason]!;
  if (reason.startsWith("SAFETY_BLOCKED:")) {
    return `A safety gate stopped the reply — ${reason.slice("SAFETY_BLOCKED:".length).trim()}`;
  }
  if (reason.startsWith("AI_ERROR:")) {
    return `The provider call failed — ${reason.slice("AI_ERROR:".length).trim()}`;
  }
  return null;
}

export function AiActivityTable({ rows }: { rows: AiActivityRow[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState>
        No AI decisions recorded yet. One row appears here for every message the rule engine missed
        in a group where AI is allowed to answer.
      </EmptyState>
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Time</Th>
          <Th>Group</Th>
          <Th>Customer said</Th>
          <Th>Outcome</Th>
          <Th>Confidence</Th>
          <Th>Why</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expanded = expandedId === row.id;
          const replied = row.outcome === "AI_REPLIED";
          return (
            <tr key={row.id}>
              <Td className="align-top">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                  aria-expanded={expanded}
                  className="flex cursor-pointer items-center gap-1 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                  )}
                  <span className="tabular whitespace-nowrap text-xs">{row.timeLabel}</span>
                </button>

                {expanded ? (
                  <div className="mt-3 max-w-md space-y-2 text-xs">
                    {row.responseText ? (
                      <div>
                        <p className="font-medium text-[color:var(--color-foreground)]">
                          {replied ? "AI replied" : "AI drafted (not sent)"}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-2 leading-relaxed text-[color:var(--color-muted-foreground)]">
                          {row.responseText}
                        </p>
                      </div>
                    ) : null}
                    <p className="text-[color:var(--color-muted-foreground)]">
                      {row.providerName ?? "No provider"}
                      {row.modelId ? ` · ${row.modelId}` : ""}
                      {row.tokensUsed ? ` · ${row.tokensUsed.toLocaleString("en-US")} tokens` : ""}
                      {row.outboundStatus ? ` · send ${row.outboundStatus}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <Link href={`/messages/${row.messageId}`} className="link">
                        Open message
                      </Link>
                      {row.groupId ? (
                        <Link href={`/chat/${row.groupId}`} className="link inline-flex items-center gap-1">
                          <MessageSquare className="size-3" aria-hidden />
                          Open conversation
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </Td>

              <Td className="align-top">
                <span className="text-xs">{row.groupName ?? "—"}</span>
                <span className="mt-0.5 block font-[family-name:var(--font-mono)] text-[10px] text-[color:var(--color-muted-foreground)]">
                  {row.senderLabel}
                </span>
              </Td>

              <Td className="max-w-xs align-top">
                <span className="line-clamp-2 text-xs">{row.customerMessage}</span>
                {row.intent ? (
                  <span className="mt-1 block text-[10px] text-[color:var(--color-muted-foreground)]">
                    Intent: {row.intent}
                  </span>
                ) : null}
              </Td>

              <Td className="align-top">
                <Badge color={replied ? "green" : "yellow"} dot>
                  {replied ? "Replied" : "Handed off"}
                </Badge>
              </Td>

              <Td className="tabular align-top text-xs">
                {row.confidenceScore === null ? "—" : `${row.confidenceScore}%`}
              </Td>

              <Td className="max-w-xs align-top">
                {row.reason ? (
                  <>
                    <span className="font-[family-name:var(--font-mono)] text-[10px] text-[color:var(--color-muted-foreground)]">
                      {row.reason}
                    </span>
                    {explainReason(row.reason) ? (
                      <span className="mt-0.5 block text-xs leading-relaxed">{explainReason(row.reason)}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">—</span>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
