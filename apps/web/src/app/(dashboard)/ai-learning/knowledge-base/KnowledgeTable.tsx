import Link from "next/link";
import { Badge, type BadgeColor, EmptyState, Table, Td, Th } from "@/components/ui";

export interface KnowledgeRow {
  id: string;
  title: string;
  category: string;
  module: string | null;
  status: string;
  currentVersion: number;
  aiGenerated: boolean;
  humanVerified: boolean;
  /** Set when the knowledge builder distilled this from a group conversation. */
  sourceGroupName: string | null;
  /** An import's own name — a file name, a page address, or whatever the operator called it. */
  sourceLabel: string | null;
  /** Set only for an entry read out of a fetched web page. */
  sourceUrl: string | null;
  updatedAtLabel: string;
}

export function KnowledgeTable({ items, filtered = false }: { items: KnowledgeRow[]; filtered?: boolean }) {
  if (items.length === 0) {
    return (
      <EmptyState>
        {filtered
          ? "No knowledge matches these filters."
          : "No knowledge yet. Add an entry, or import your own documentation."}
      </EmptyState>
    );
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
              {item.module ? (
                <span className="mt-0.5 block text-[10px] text-[color:var(--color-muted-foreground)]">
                  {item.module}
                </span>
              ) : null}
            </Td>
            <Td>{item.category.replace(/_/g, " ")}</Td>
            <Td>
              <Provenance item={item} />
            </Td>
            <Td>
              {/* Anything the knowledge builder or an importer wrote arrives unverified — a
                  model's reading of a chat log or a manual is evidence, not fact — so the review
                  state has to be visible in the list, not buried on the detail page. */}
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

/**
 * Where the entry came from, most specific first. A fetched page is shown as a real link: when a
 * documentation page changes, the only way to find the entries it affects is to be able to see
 * and follow the address that produced them.
 */
function Provenance({ item }: { item: KnowledgeRow }) {
  if (item.sourceGroupName) {
    return (
      <span className="text-xs">
        <span className="text-[color:var(--color-muted-foreground)]">Learned from </span>
        {item.sourceGroupName}
      </span>
    );
  }
  if (item.sourceUrl) {
    return (
      <a
        href={item.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="link block max-w-56 truncate text-xs"
        title={item.sourceUrl}
      >
        {item.sourceUrl.replace(/^https?:\/\//, "")}
      </a>
    );
  }
  if (item.sourceLabel) {
    return (
      <span className="block max-w-56 truncate text-xs" title={item.sourceLabel}>
        <span className="text-[color:var(--color-muted-foreground)]">Imported from </span>
        {item.sourceLabel}
      </span>
    );
  }
  return <span className="text-xs">{item.aiGenerated ? "AI generated" : "Manual"}</span>;
}

function statusColor(status: string): BadgeColor {
  if (status === "ACTIVE") return "green";
  if (status === "ARCHIVED") return "gray";
  return "yellow";
}
