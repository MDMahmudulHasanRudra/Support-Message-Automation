"use client";

import Link from "next/link";
import { Badge, EmptyState, Table, Td, Th } from "@/components/ui";

export interface IssueRow {
  id: string;
  title: string | null;
  clientPhone: string;
  groupName: string;
  status: string;
  teamsChannelName: string | null;
  createdAtLabel: string;
}

const STATUS_COLOR: Record<string, "green" | "gray" | "blue" | "yellow" | "red"> = {
  OPEN: "gray",
  IN_PROGRESS: "blue",
  WAITING_DEVELOPER: "yellow",
  RESOLUTION_DETECTED: "yellow",
  WAITING_CUSTOMER_CHECK: "yellow",
  RESOLVED: "green",
  CLOSED: "gray",
};

export function IssuesTable({ issues }: { issues: IssueRow[] }) {
  if (issues.length === 0) {
    return <EmptyState>No issues yet — create one to link a WhatsApp conversation to a Teams thread.</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Issue</Th>
          <Th>Customer</Th>
          <Th>WhatsApp Group</Th>
          <Th>Teams Channel</Th>
          <Th>Status</Th>
          <Th>Created</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id}>
            <Td className="font-medium">{issue.title ?? `Issue ${issue.id.slice(-6)}`}</Td>
            <Td>{issue.clientPhone}</Td>
            <Td>{issue.groupName}</Td>
            <Td>{issue.teamsChannelName ?? "Not linked"}</Td>
            <Td>
              <Badge color={STATUS_COLOR[issue.status] ?? "gray"} dot>
                {issue.status.replace(/_/g, " ")}
              </Badge>
            </Td>
            <Td>{issue.createdAtLabel}</Td>
            <Td>
              <Link href={`/issues/${issue.id}`} className="text-xs font-medium text-[color:var(--color-primary)] hover:underline">
                View
              </Link>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
