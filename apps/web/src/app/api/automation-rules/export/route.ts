import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@support-automation/db";
import type { Prisma, RuleStatus, RuleType } from "@prisma/client";
import { RULE_STATUS, RULE_TYPE, buildRuleExportRow, isRuleActionArray, isRuleConditions, sanitizeExcelRow } from "@support-automation/shared";
import { requireSession } from "@/server/auth";

/**
 * Export endpoint for the Automation Rules bulk-management feature — same justified exception as
 * Support Activity's own export route (a file download can't be triggered from a Server Action).
 * Two modes: `ids` (comma-separated) exports exactly those rules ("Export Selected" — re-validated
 * against the database, never trusted as-is); otherwise `search`/`status`/`type` mirror the Rules
 * list page's own filters ("Export Filtered" — exports what's actually on screen, never more).
 * Every string cell is run through sanitizeExcelCell (via sanitizeExcelRow) before being written —
 * this repo's existing xlsx export (Support Activity) has no such protection; this one does.
 */
export async function GET(request: NextRequest) {
  await requireSession();

  const params = request.nextUrl.searchParams;
  const idsParam = params.get("ids");

  let where: Prisma.AutomationRuleWhereInput;
  if (idsParam) {
    const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean);
    where = { id: { in: ids } };
  } else {
    const search = params.get("search")?.trim();
    const statusParam = params.get("status");
    const typeParam = params.get("type");
    where = {
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      ...((RULE_STATUS as readonly string[]).includes(statusParam ?? "") ? { status: statusParam as RuleStatus } : {}),
      ...((RULE_TYPE as readonly string[]).includes(typeParam ?? "") ? { type: typeParam as RuleType } : {}),
    };
  }

  const rules = await prisma.automationRule.findMany({
    where,
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });

  const rows = rules.map((rule) =>
    sanitizeExcelRow(
      buildRuleExportRow({
        name: rule.name,
        description: rule.description,
        type: rule.type,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        keywords: rule.keywords,
        priority: rule.priority,
        status: rule.status,
        actions: isRuleActionArray(rule.actions) ? rule.actions : [],
        conditions: isRuleConditions(rule.conditions) ? rule.conditions : {},
        replyMessage: rule.replyMessage,
        cooldownSeconds: rule.cooldownSeconds,
        replyDelayMinMs: rule.replyDelayMinMs,
        replyDelayMaxMs: rule.replyDelayMaxMs,
        executionCount: rule.executionCount,
        updatedAt: rule.updatedAt,
      }),
    ),
  );

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Automation Rules");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const baseName = `automation-rules-${new Date().toISOString().slice(0, 10)}`;
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
    },
  });
}
