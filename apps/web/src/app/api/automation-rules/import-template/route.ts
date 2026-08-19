import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { buildRuleImportTemplateRows } from "@support-automation/shared";
import { requireSession } from "@/server/auth";

/**
 * Downloadable Excel import template/demo file for the Automation Rules bulk-import feature — a
 * file download can't be triggered from a Server Action, so a plain GET Route Handler is the same
 * justified exception this app already uses for Support Activity's export
 * (apps/web/src/app/api/support-activity/export/route.ts). Generated fresh from the real
 * schema/enum values on every request (via buildRuleImportTemplateRows(), packages/shared) rather
 * than a static asset that could drift out of sync with the actual AutomationRule model — this
 * generated file IS the demo/example file: real, valid example rows an admin can edit in place.
 */
export async function GET() {
  await requireSession();

  const rows = buildRuleImportTemplateRows();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Automation Rules");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="automation-rules-import-template.xlsx"',
    },
  });
}
