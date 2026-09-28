import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { buildKnowledgeImportTemplateRows } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";

/**
 * The question/answer sheet the knowledge importer's spreadsheet mode expects — the same justified
 * Route Handler exception as the Automation Rules template (a file download can't be triggered
 * from a Server Action). Generated fresh from the real column labels and category values on every
 * request rather than shipped as a static asset that would drift the moment either changes.
 *
 * The example rows are real, valid rows: an admin can edit them in place instead of guessing what
 * a Category column will accept.
 */
export async function GET() {
  await requireAccess("ai_learning.manage");

  const worksheet = XLSX.utils.json_to_sheet(buildKnowledgeImportTemplateRows());
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Knowledge");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="knowledge-import-template.xlsx"',
    },
  });
}
