import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { CLIENT_EXPORT_COLUMNS, CLIENT_SOURCE_LABELS, clientSubscriptionState, dhakaToday, sanitizeExcelCell, SUBSCRIPTION_STATE_LABELS, type ClientSourceValue } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { requireAccess } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { contentDisposition, toCsv, type Cell } from "@/server/reports/exportFile";
import { buildClientWhere, clientOrderBy, MAX_CLIENT_BULK, parseClientFilters } from "@/lib/clientFilters";
import { clientFilterContext } from "@/server/clientModule";
import { countryName } from "@/lib/clientPhone";

/**
 * Clients out of the application (CLIENT_CENTER.md). Personal data leaves the system here, so it
 * needs its own key (`clients.export`) — viewing a client does not include taking the list away.
 *
 * GET exports what the list shows: the SAME filter builder as the page, so "export the 312 on screen"
 * is those 312. POST exports an explicit selection (`ids`). Both are capped, and a request over the
 * cap is refused with the reason rather than quietly truncated. Every text cell is formula-safe (CSV
 * too — Excel opens it the same way). The export is recorded in System Logs: who, how many, in what
 * format — never the clients.
 */
async function exportClients(where: ReturnType<typeof buildClientWhere>, format: string, userId: string, how: string, renewalWindowDays: number) {
  const total = await prisma.client.count({ where });
  if (total > MAX_CLIENT_BULK) {
    return NextResponse.json({ error: `${total.toLocaleString()} clients match; one export takes at most ${MAX_CLIENT_BULK.toLocaleString()}. Narrow the filters first.` }, { status: 400 });
  }
  const clients = await prisma.client.findMany({
    where,
    orderBy: clientOrderBy("name", "asc"),
    take: MAX_CLIENT_BULK,
    include: {
      channels: { select: { kind: true, value: true, normalizedValue: true } },
      soldByMember: { select: { name: true } },
      assignedTeam: { select: { name: true } },
      currentSubscription: { select: { id: true, service: true, kind: true, startDate: true, endDate: true, pausedAt: true, cancelledAt: true, isRenewal: true, soldByName: true } },
      groupLinks: { where: { unlinkedAt: null }, select: { groupName: true } },
    },
  });
  const today = dhakaToday(new Date());

  const cell = (value: string | null | undefined): Cell => sanitizeExcelCell(value ?? "");
  const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  const rows: Cell[][] = clients.map((c) => [
    cell(c.code),
    cell(c.name),
    cell(c.companyName),
    c.status,
    cell(c.category),
    cell(c.tags.join("; ")),
    // Numbers as digits: no leading "+" for a spreadsheet to read as a formula.
    cell(c.channels.filter((ch) => ch.kind === "PHONE").map((ch) => ch.normalizedValue).join("; ")),
    cell(c.channels.filter((ch) => ch.kind === "EMAIL").map((ch) => ch.value).join("; ")),
    cell(c.channels.filter((ch) => ch.kind === "WHATSAPP").map((ch) => ch.normalizedValue).join("; ")),
    cell(c.preferredLanguage),
    cell(c.address),
    CLIENT_SOURCE_LABELS[c.source as ClientSourceValue] ?? c.source,
    date(c.createdAt),
    date(c.lastContactAt),
    // Clients V3 columns: subscription TERMS and links, never an amount (billing has its own key).
    cell(countryName(c.country) ?? ""),
    cell(c.preferredCurrency),
    cell(c.assignedTeam?.name),
    cell(c.currentSubscription?.soldByName ?? c.soldByMember?.name),
    cell(c.currentSubscription?.service),
    date(c.currentSubscription?.startDate ?? null),
    date(c.currentSubscription?.endDate ?? null),
    c.currentSubscription
      ? SUBSCRIPTION_STATE_LABELS[
          clientSubscriptionState(
            { ...c.currentSubscription, startDate: date(c.currentSubscription.startDate), endDate: date(c.currentSubscription.endDate) },
            false,
            today,
            renewalWindowDays,
          )
        ]
      : "",
    cell(c.groupLinks.map((g) => g.groupName).join("; ")),
  ]);

  await logSystemEvent("INFO", "clients", `Exported ${rows.length} client(s) as ${format}`, { count: rows.length, format, how }, { actorUserId: userId, targetType: "Client" });

  const base = `clients-${new Date().toISOString().slice(0, 10)}`;
  const header = [...CLIENT_EXPORT_COLUMNS] as string[];
  if (format === "csv") {
    return new NextResponse(toCsv(header, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": contentDisposition(`${base}.csv`), "Cache-Control": "no-store" },
    });
  }
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Clients");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition(`${base}.xlsx`),
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  const session = await requireAccess("clients.export");
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const format = params.format === "csv" ? "csv" : "xlsx";
  const ctx = await clientFilterContext(session);
  return exportClients(buildClientWhere(parseClientFilters(params), ctx), format, session.userId, "filters", ctx.renewalWindowDays);
}

export async function POST(request: NextRequest) {
  const session = await requireAccess("clients.export");
  let body: { ids?: unknown; format?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the selected client ids as JSON." }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length < 64))] : [];
  if (!ids.length) return NextResponse.json({ error: "Select at least one client." }, { status: 400 });
  if (ids.length > MAX_CLIENT_BULK) return NextResponse.json({ error: `Select at most ${MAX_CLIENT_BULK.toLocaleString()} clients.` }, { status: 400 });
  // Archived clients can be exported when chosen explicitly: nothing here hides what was selected.
  return exportClients({ id: { in: ids } }, body.format === "csv" ? "csv" : "xlsx", session.userId, "selection", (await clientFilterContext(session)).renewalWindowDays);
}
