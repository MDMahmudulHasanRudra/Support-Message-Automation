"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { Badge, type BadgeColor, Table, Td, Th, Tooltip } from "@/components/ui";

export interface LogRow {
  id: string;
  timeLabel: string;
  level: string;
  scope: string;
  message: string;
  /** Groups every line belonging to one incoming message. Written since the log was built, and
   *  until now displayed nowhere — so the trail it exists to make followable was unfollowable. */
  correlationId: string | null;
  metadataJson: string | null;
}

export function LogsTable({
  logs,
  buildTrailHref,
}: {
  logs: LogRow[];
  /** Filters the page down to one correlation trail. Omitted where the caller has no filter state. */
  buildTrailHref?: (correlationId: string) => string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>{null}</Th>
          <Th>Time</Th>
          <Th>Level</Th>
          <Th>Scope</Th>
          <Th>Message</Th>
          <Th>Trail</Th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log) => {
          const isOpen = expanded.has(log.id);
          return (
            <Fragment key={log.id}>
              <tr>
                <Td>
                  {log.metadataJson ? (
                    <button
                      type="button"
                      onClick={() => toggle(log.id)}
                      aria-label={isOpen ? "Collapse details" : "Expand details"}
                      className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-3.5" aria-hidden />
                      ) : (
                        <ChevronRight className="size-3.5" aria-hidden />
                      )}
                    </button>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap font-[family-name:var(--font-mono)] text-xs">{log.timeLabel}</Td>
                <Td>
                  <Badge color={levelColor(log.level)} dot>
                    {log.level}
                  </Badge>
                </Td>
                <Td className="font-[family-name:var(--font-mono)] text-xs">{log.scope}</Td>
                <Td className="max-w-xl">{log.message}</Td>
                <Td className="w-px">
                  {/* One click from "this line looks wrong" to every line that came from the same
                      incoming message — which is what the column was always for. */}
                  {log.correlationId && buildTrailHref ? (
                    <Tooltip content="Show every entry from this same event">
                      <Link
                        href={buildTrailHref(log.correlationId)}
                        aria-label="Show this event's full trail"
                        className="flex size-6 items-center justify-center rounded-[var(--radius-xs)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
                      >
                        <GitBranch className="size-3.5" aria-hidden />
                      </Link>
                    </Tooltip>
                  ) : null}
                </Td>
              </tr>
              {isOpen && log.metadataJson ? (
                <tr>
                  <td colSpan={6} className="border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-4 py-3">
                    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap font-[family-name:var(--font-mono)] text-xs text-[color:var(--color-foreground)]">
                      {log.metadataJson}
                    </pre>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

function levelColor(level: string): BadgeColor {
  if (level === "ERROR") return "red";
  if (level === "WARN") return "yellow";
  return "gray";
}
