import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";

/**
 * Export for the Microsoft Teams integration — the last of that module's documented deferred
 * phases that is actually buildable here.
 *
 * Same shape as /api/support-activity/export and for the same reason: a file download cannot be
 * triggered from a Server Action, so a plain GET returning Content-Disposition is the justified
 * exception to this app being Server Components and Server Actions throughout.
 *
 * Two things this deliberately does not do. It does not paginate — a Teams export is bounded by
 * how much a team has discussed in linked channels, which is orders of magnitude smaller than the
 * message table, and a partial export is worse than a slow one. And it does not include message
 * bodies for channels outside an open Issue's scope, because those were never pulled in the first
 * place (see graphSync's isChannelInAutomationScope).
 */

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escapeCell = (value: unknown) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","))].join("\n");
}

function fileResponse(body: string | Buffer, filename: string, contentType: string) {
  return new NextResponse(body as unknown as BodyInit, {
    headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"` },
  });
}

export async function GET(request: NextRequest) {
  await requireSession();

  const params = request.nextUrl.searchParams;
  const type = params.get("type") === "messages" ? "messages" : "issues";
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";

  const rows =
    type === "messages" ? await messageRows() : await issueRows();

  const filename = `teams-${type}-${new Date().toISOString().slice(0, 10)}.${format}`;

  if (format === "xlsx") {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, type);
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return fileResponse(buffer, filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  return fileResponse(toCsv(rows), filename, "text/csv; charset=utf-8");
}

/**
 * One row per linked Issue, with the resolution outcome — the thing anyone exporting this actually
 * wants to answer: how long developer conversations take to resolve a customer's problem.
 */
async function issueRows(): Promise<Array<Record<string, unknown>>> {
  const issues = await prisma.supportIssue.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      group: { select: { name: true } },
      supportExecutive: { select: { name: true } },
      teamsChannel: { select: { name: true, team: { select: { name: true } } } },
      resolutionEvents: { select: { detectedAt: true }, orderBy: { detectedAt: "asc" }, take: 1 },
    },
  });

  return issues.map((issue) => {
    const firstResolution = issue.resolutionEvents[0]?.detectedAt ?? null;
    return {
      "Issue ID": issue.id,
      Title: issue.title ?? "",
      Status: issue.status,
      "WhatsApp group": issue.group?.name ?? "",
      "Customer phone": issue.clientPhone,
      "Teams team": issue.teamsChannel?.team?.name ?? "",
      "Teams channel": issue.teamsChannel?.name ?? "",
      "Assigned to": issue.supportExecutive?.name ?? "",
      Created: formatDateTime(issue.createdAt),
      "First resolution signal": firstResolution ? formatDateTime(firstResolution) : "",
      Resolved: issue.resolvedAt ? formatDateTime(issue.resolvedAt) : "",
      // Minutes rather than seconds: these are conversations between people over hours or days,
      // and second-level precision would imply an accuracy polling every few minutes cannot have.
      "Minutes to resolve":
        issue.resolvedAt ? Math.round((issue.resolvedAt.getTime() - issue.createdAt.getTime()) / 60_000) : "",
    };
  });
}

async function messageRows(): Promise<Array<Record<string, unknown>>> {
  const messages = await prisma.teamsMessage.findMany({
    orderBy: { sentAt: "desc" },
    take: 10_000,
    include: { channel: { select: { name: true, team: { select: { name: true } } } } },
  });

  return messages.map((message) => ({
    Team: message.channel.team.name,
    Channel: message.channel.name,
    From: message.senderDisplayName ?? "",
    Sent: formatDateTime(message.sentAt),
    Message: message.body,
  }));
}
