import Link from "next/link";
import type { RuleProposalSource, RuleProposalStatus } from "@prisma/client";
import { Badge, type BadgeColor, Table, Td, Th } from "@/components/ui";

export interface RuleProposalRow {
  id: string;
  name: string;
  confidenceScoreSnapshot: number;
  source: RuleProposalSource;
  status: RuleProposalStatus;
  createdAtLabel: string;
}

export function RuleProposalsTable({ proposals }: { proposals: RuleProposalRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Proposed Rule</Th>
          <Th>Drafted from</Th>
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
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-foreground)]"
              >
                {proposal.name}
              </Link>
            </Td>
            <Td>
              {/* The two sources carry different evidence — a recurring pattern seen many
                  times, versus one answer the AI was confident about — so a reviewer needs to
                  know which they are reading before they judge the confidence number beside it. */}
              <Badge color={proposal.source === "AI_REPLY" ? "blue" : "gray"}>
                {proposal.source === "AI_REPLY" ? "AI answer" : "Recurring pattern"}
              </Badge>
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
