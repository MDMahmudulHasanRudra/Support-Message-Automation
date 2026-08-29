import Link from "next/link";
import { Badge, type BadgeColor, EmptyState, Table, Td, Th } from "@/components/ui";

export interface KnowledgeRow {
  id: string;
  title: string;
  category: string;
  status: string;
  currentVersion: number;
  aiGenerated: boolean;
  humanVerified: boolean;
  /** Set when the knowledge builder distilled this from a group conversation. */
  sourceGroupName: string | null;
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
          <Th>Checked</Th>
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
                className="underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-foreground)]"
              >
                {item.title}
              </Link>
            </Td>
            <Td>{item.category.replace(/_/g, " ")}</Td>
            <Td>
              {item.sourceGroupName ? (
                <span className="text-xs">
                  <span className="text-[color:var(--color-muted-foreground)]">Learned from </span>
                  {item.sourceGroupName}
                </span>
              ) : (
                <span className="text-xs">{item.aiGenerated ? "AI generated" : "Manual"}</span>
              )}
            </Td>
            <Td>
              {/* Anything the knowledge builder wrote arrives unverified — a model's reading of
                  a chat log is evidence, not fact — so the review state has to be visible in the
                  list, not buried on the detail page. */}
              {item.humanVerified ? (
                <Badge color="green" dot>
                  Verified
                </Badge>
              ) : (
                <Badge color="yellow" dot>
                  Needs review
                </Badge>
              )}
            </Td>
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
