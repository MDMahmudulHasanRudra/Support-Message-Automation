import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import { KNOWLEDGE_ROW_COLUMN_LABELS, sanitizeExcelRow } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";

/**
 * Exports VERIFIED sandbox answers as knowledge — one turn, or every verified turn in a test
 * conversation. A Route Handler because a file download cannot come from a Server Action.
 *
 * The columns are the Knowledge Base spreadsheet import's own (KNOWLEDGE_ROW_COLUMN_LABELS:
 * Question, Answer, Title, Category, Module, Procedure), in that order, so an exported file imports
 * straight back through Knowledge Base → Import with nothing renamed. Status and AI classification
 * follow as extra columns; the importer ignores columns it does not know.
 *
 * Only APPROVED turns are exported, and always with the FINAL answer (the admin's edit when there is
 * one) — the same text Make Knowledge would save. A waiting or rejected answer is never exported as
 * knowledge. Read-only: nothing is written and nothing is sent anywhere.
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

export async function GET(request: NextRequest) {
  await requireAccess("conversation_learning.view");
  const params = request.nextUrl.searchParams;
  const sessionId = params.get("session") ?? "";
  const turnId = params.get("turn");
  const format = params.get("format") === "xlsx" ? "xlsx" : params.get("format") === "json" ? "json" : "csv";

  const turns = await prisma.sandboxTurn.findMany({
    where: { sessionId, review: "APPROVED", ...(turnId ? { id: turnId } : {}) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userMessage: true,
      responseText: true,
      editedResponseText: true,
      intent: true,
      scope: true,
      promotedKnowledgeItemId: true,
    },
  });

  // A saved turn exports the knowledge entry's own title and category, so the file matches it.
  const promotedIds = turns.map((t) => t.promotedKnowledgeItemId).filter((id): id is string => Boolean(id));
  const items = promotedIds.length
    ? await prisma.aiKnowledgeItem.findMany({
        where: { id: { in: promotedIds } },
        select: { id: true, title: true, category: true, question: true, answer: true },
      })
    : [];
  const itemById = new Map(items.map((item) => [item.id, item]));

  const L = KNOWLEDGE_ROW_COLUMN_LABELS;
  const rows = turns
    .map((turn) => {
      const saved = turn.promotedKnowledgeItemId ? itemById.get(turn.promotedKnowledgeItemId) : undefined;
      const answer = saved?.answer ?? (turn.editedResponseText?.trim() || turn.responseText?.trim() || "");
      if (!answer) return null;
      return sanitizeExcelRow({
        [L.question]: saved?.question ?? turn.userMessage,
        [L.answer]: answer,
        [L.title]: saved?.title ?? (turn.intent?.trim() || turn.userMessage.slice(0, 80)),
        [L.category]: saved?.category ?? "FAQ",
        [L.module]: "",
        [L.procedure]: "",
        Status: saved ? "Saved to knowledge" : "Verified",
        "AI classification": turn.scope === "BUSINESS_SPECIFIC" ? "Business specific" : turn.scope === "GENERAL" ? "General" : "",
        "Edited by admin": turn.editedResponseText ? "Yes" : "No",
      });
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const name = `verified-knowledge_${turnId ? "answer" : "conversation"}_${new Date().toISOString().slice(0, 10)}`;

  if (format === "json") {
    return new NextResponse(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.json"` },
    });
  }
  if (format === "csv") {
    return new NextResponse(toCsv(rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` },
    });
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "No verified answers to export." }]),
    "Knowledge",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}.xlsx"`,
    },
  });
}
