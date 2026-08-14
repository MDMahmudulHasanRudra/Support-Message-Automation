import Link from "next/link";
import type { RuleProposalStatus } from "@prisma/client";
import { Badge, type BadgeColor, Table, Td, Th } from "@/components/ui";

export interface RuleProposalRow {
  id: string;
  name: string;
  confidenceScoreSnapshot: number;
  status: RuleProposalStatus;
  createdAtLabel: string;
}

export function RuleProposalsTable({ proposals }: { proposals: RuleProposalRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Proposed Rule</Th>
          <Th>Confidence</Th>
          <Th>Status</Th>
          <Th>Created</Th>
        </tr>
      </thead>
      <tbody>
        {proposals.map((proposal) => (
          <tr key={proposal.id}>
            <Td>
              <Link
                href={`/conversation-learning/rule-proposals/${proposal.id}`}
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
              >
                {proposal.name}
              </Link>
            </Td>
            <Td className="tabular-nums">{proposal.confidenceScoreSnapshot}</Td>
            <Td>
              <Badge color={statusColor(proposal.status)} dot>
                {proposal.status.replace(/_/g, " ")}
              </Badge>
            </Td>
            <Td>{proposal.createdAtLabel}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function statusColor(status: RuleProposalStatus): BadgeColor {
  if (status === "APPROVED" || status === "CONVERTED") return "green";
  if (status === "REJECTED") return "red";
  if (status === "WITHDRAWN") return "gray";
  return "blue"; // PENDING_REVIEW
}
