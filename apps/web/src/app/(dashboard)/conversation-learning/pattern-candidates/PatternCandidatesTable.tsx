import Link from "next/link";
import type { PatternCandidateStatus } from "@prisma/client";
import { Badge, type BadgeColor, Table, Td, Th } from "@/components/ui";

export interface PatternCandidateRow {
  id: string;
  keywords: string[];
  occurrenceCount: number;
  distinctGroupCount: number;
  distinctClientCount: number;
  confidenceScore: number;
  status: PatternCandidateStatus;
  lastSeenAtLabel: string;
}

export function PatternCandidatesTable({ candidates }: { candidates: PatternCandidateRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Pattern</Th>
          <Th>Occurrences</Th>
          <Th>Groups</Th>
          <Th>Clients</Th>
          <Th>Confidence</Th>
          <Th>Status</Th>
          <Th>Last Seen</Th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((candidate) => (
          <tr key={candidate.id}>
            <Td>
              <Link
                href={`/conversation-learning/pattern-candidates/${candidate.id}`}
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
              >
                {candidate.keywords.join(", ") || "(no distinctive keywords)"}
              </Link>
            </Td>
            <Td className="tabular-nums">{candidate.occurrenceCount}</Td>
            <Td className="tabular-nums">{candidate.distinctGroupCount}</Td>
            <Td className="tabular-nums">{candidate.distinctClientCount}</Td>
            <Td className="tabular-nums">{candidate.confidenceScore}</Td>
            <Td>
              <Badge color={statusColor(candidate.status)} dot>
                {candidate.status.replace(/_/g, " ")}
              </Badge>
            </Td>
            <Td>{candidate.lastSeenAtLabel}</Td>
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
