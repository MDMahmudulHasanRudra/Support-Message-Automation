import { prisma } from "@/server/db";
import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";

import type { AiKnowledgeCategory, AiKnowledgeStatus, Prisma } from "@prisma/client";
import { KNOWLEDGE_IMPORT_CATEGORIES, buildKnowledgeExportRow, sanitizeExcelRow } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";

/**
 * Gets the knowledge base back out of the application.
 *
 * This matters more here than for any other export in the app: the knowledge base is the one
 * asset a deployment builds up over months, and the system's claim to being provider-independent
 * is empty if the knowledge itself can only be read through this dashboard. The importable
 * columns come first and are spelled the way the import template spells them, so an export is a
 * working round trip — edit it in Excel, upload it again.
 *
 * `search`/`status`/`category`/`module` mirror the list page's own filters, so the file contains
 * what was on screen and never more. Every string cell goes through sanitizeExcelCell (via
 * sanitizeExcelRow) — a title or an answer is free text somebody typed, which is precisely the
 * material a formula-injection payload hides in.
 */
/** Mirrors AiKnowledgeStatus. Only these three reach the query; anything else is ignored. */
const KNOWLEDGE_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;

export async function GET(request: NextRequest) {
  await requireAccess("ai_learning.view");

  const params = request.nextUrl.searchParams;
  const search = params.get("search")?.trim();
  const statusParam = params.get("status");
  const categoryParam = params.get("category");
  const moduleParam = params.get("module")?.trim();

  const where: Prisma.AiKnowledgeItemWhereInput = {
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" as const } },
            { question: { contains: search, mode: "insensitive" as const } },
            { answer: { contains: search, mode: "insensitive" as const } },
            { module: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...((KNOWLEDGE_STATUSES as readonly string[]).includes(statusParam ?? "")
      ? { status: statusParam as AiKnowledgeStatus }
      : {}),
    ...((KNOWLEDGE_IMPORT_CATEGORIES as readonly string[]).includes(categoryParam ?? "")
      ? { category: categoryParam as AiKnowledgeCategory }
      : {}),
    ...(moduleParam ? { module: moduleParam } : {}),
  };

  const items = await prisma.aiKnowledgeItem.findMany({ where, orderBy: { updatedAt: "desc" } });
  const rows = items.map((item) => sanitizeExcelRow(buildKnowledgeExportRow(item)));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const baseName = `knowledge-base-${new Date().toISOString().slice(0, 10)}`;

  // CSV is offered because a knowledge base is the export most likely to be fed to something
  // other than Excel — another support tool, a script, a different vendor's importer.
  if (params.get("format") === "csv") {
    return new NextResponse(XLSX.utils.sheet_to_csv(worksheet), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.csv"`,
      },
    });
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Knowledge");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
    },
  });
}
