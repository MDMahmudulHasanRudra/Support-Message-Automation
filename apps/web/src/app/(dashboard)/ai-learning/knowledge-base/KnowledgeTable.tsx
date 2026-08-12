import Link from "next/link";
import { Badge, type BadgeColor, EmptyState, Table, Td, Th } from "@/components/ui";

export interface KnowledgeRow {
  id: string;
  title: string;
  category: string;
  status: string;
  currentVersion: number;
  aiGenerated: boolean;
  updatedAtLabel: string;
}

export function KnowledgeTable({ items }: { items: KnowledgeRow[] }) {
  if (items.length === 0) {
    return <EmptyState>No knowledge yet. Add an entry to get started.</EmptyState>;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Title</Th>
          <Th>Category</Th>
          <Th>Source</Th>
          <Th>Version</Th>
          <Th>Status</Th>
          <Th>Updated</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <Td>
              <Link
                href={`/ai-learning/knowledge-base/${item.id}`}
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
              >
                {item.title}
              </Link>
            </Td>
            <Td>{item.category.replace(/_/g, " ")}</Td>
            <Td>{item.aiGenerated ? "AI Generated" : "Manual"}</Td>
            <Td className="tabular-nums">{item.currentVersion}</Td>
            <Td>
              <Badge color={statusColor(item.status)} dot>
                {item.status}
              </Badge>
            </Td>
            <Td>{item.updatedAtLabel}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "ACTIVE") return "green";
  if (status === "ARCHIVED") return "gray";
  return "yellow";
}
