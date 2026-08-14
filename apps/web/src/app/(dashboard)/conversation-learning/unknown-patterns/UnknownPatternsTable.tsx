import Link from "next/link";
import type { NotificationStatus, PatternCandidateStatus } from "@prisma/client";
import { Badge, type BadgeColor, Table, Td, Th } from "@/components/ui";

export interface UnknownPatternRow {
  id: string;
  keywords: string[];
  status: PatternCandidateStatus;
  confidenceScore: number;
  unhandledCount: number;
  distinctGroupCount: number;
  distinctClientCount: number;
  firstSeenAtLabel: string;
  lastSeenAtLabel: string;
  latestExample: string | null;
  notificationStatus: NotificationStatus | null;
}

export function UnknownPatternsTable({ patterns }: { patterns: UnknownPatternRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Pattern</Th>
          <Th>Status</Th>
          <Th>Confidence</Th>
          <Th>Occurrences</Th>
          <Th>Groups</Th>
          <Th>Clients</Th>
          <Th>First Seen</Th>
          <Th>Last Seen</Th>
          <Th>Latest Example</Th>
          <Th>Notification</Th>
        </tr>
      </thead>
      <tbody>
        {patterns.map((pattern) => (
          <tr key={pattern.id}>
            <Td>
              <Link
                href={`/conversation-learning/pattern-candidates/${pattern.id}`}
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
              >
                {pattern.keywords.join(", ") || "(no distinctive keywords)"}
              </Link>
            </Td>
            <Td>
              <Badge color={statusColor(pattern.status)} dot>
                {pattern.status.replace(/_/g, " ")}
              </Badge>
            </Td>
            <Td className="tabular-nums">{pattern.confidenceScore}</Td>
            <Td className="tabular-nums">{pattern.unhandledCount}</Td>
            <Td className="tabular-nums">{pattern.distinctGroupCount}</Td>
            <Td className="tabular-nums">{pattern.distinctClientCount}</Td>
            <Td>{pattern.firstSeenAtLabel}</Td>
            <Td>{pattern.lastSeenAtLabel}</Td>
            <Td className="max-w-xs truncate">
              <span title={pattern.latestExample ?? undefined}>{pattern.latestExample ?? "—"}</span>
            </Td>
            <Td>
              {pattern.notificationStatus ? (
                <Badge color={notificationColor(pattern.notificationStatus)} dot>
                  {pattern.notificationStatus}
                </Badge>
              ) : (
                <span className="text-[color:var(--color-muted-foreground)]">—</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function statusColor(status: PatternCandidateStatus): BadgeColor {
  if (status === "PENDING_REVIEW") return "blue";
  if (status === "APPROVED") return "green";
  if (status === "REJECTED") return "red";
  if (status === "MERGED" || status === "EXPIRED") return "gray";
  return "yellow"; // PENDING_ANALYSIS, ANALYZED
}

function notificationColor(status: NotificationStatus): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  return "yellow"; // PENDING, RETRYING
}
