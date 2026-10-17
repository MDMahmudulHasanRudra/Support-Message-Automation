import { NextResponse, type NextRequest } from "next/server";
import { MAX_CLIENT_IMPORT_ROWS } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { requireActiveProject } from "@/server/projectContext";
import { logSystemEvent } from "@/server/logSystemEvent";
import { contentDisposition } from "@/server/reports/exportFile";
import { buildClientWhere, parseClientFilters } from "@/lib/clientFilters";
import { clientFilterContext } from "@/server/clientModule";
import { buildClientImportTemplate } from "@/server/clientImportTemplate";

/**
 * The import template (CLIENTS_V3.md §Import). `clients.import` downloads the blank template: column
 * tips, drop-downs from this project's teams, staff, countries and currencies, an Example sheet and a
 * How to fill sheet. `?data=current` fills the Clients sheet with the clients this person can see,
 * for edit-and-re-upload — personal data leaving the system, so it also needs `clients.export` and is
 * recorded in System Logs exactly like an export.
 */
export async function GET(request: NextRequest) {
  const session = await requireAccess("clients.import");
  const withClients = request.nextUrl.searchParams.get("data") === "current";
  let clientsWhere = null;
  if (withClients) {
    if (!(await hasPermission(session, "clients.export"))) {
      return NextResponse.json({ error: "Downloading your clients needs the Export clients permission. The blank template does not." }, { status: 403 });
    }
    const ctx = await clientFilterContext(session);
    clientsWhere = buildClientWhere(parseClientFilters({}), ctx);
  }
  const project = await requireActiveProject();
  const { bytes, truncated } = await buildClientImportTemplate({ clientsWhere, projectName: project.name, maxRows: MAX_CLIENT_IMPORT_ROWS });
  if (withClients) {
    await logSystemEvent("INFO", "clients", "Downloaded the import template with current clients", { truncated }, { actorUserId: session.userId, targetType: "Client" });
  }
  const day = new Date().toISOString().slice(0, 10);
  const name = withClients ? `clients-for-import-${project.slug}-${day}.xlsx` : `client-import-template-${project.slug}.xlsx`;
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(name),
      "Cache-Control": "no-store",
    },
  });
}
