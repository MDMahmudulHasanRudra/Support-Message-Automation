import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { CONTACT_CONSENT_LABEL, CONTACT_IDENTIFIER_LABEL, CONTACT_SOURCE_LABEL, formatContactSerial, sanitizeExcelCell, type ContactIdentifierKindValue } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { readContactFilters, selectionWhere, type ContactSelection } from "@/server/contacts";

/** Contacts as a file (CONTACTS.md): the selected rows, or everything the page's filters match. POST because a selection does not fit a URL. */

const MAX_ROWS = 20000;
const KINDS: ContactIdentifierKindValue[] = ["PHONE", "EMAIL", "FACEBOOK", "INSTAGRAM", "TELEGRAM", "TIKTOK", "LINKEDIN", "X", "YOUTUBE", "WEBSITE", "OTHER"];

// A number starting with + is not a formula; every other leading =, +, - or @ is defused.
const cell = (value: string) => (/^\+\d+$/.test(value) ? value : sanitizeExcelCell(value));

export async function POST(request: NextRequest) {
  await requireAccess("contacts.export", "CONTACTS");
  let body: { ids?: unknown; filters?: unknown; format?: unknown };
  try {
    body = await request.json();
  } catch {
    return new NextResponse("The export request was not readable.", { status: 400 });
  }
  const selection: ContactSelection = Array.isArray(body.ids) ? { ids: body.ids.filter((x): x is string => typeof x === "string") } : { filters: readContactFilters((body.filters as Record<string, unknown>) ?? {}) };
  const rows = await prisma.contact.findMany({
    where: selectionWhere(selection),
    orderBy: { serial: "asc" },
    take: MAX_ROWS + 1,
    include: { identifiers: { orderBy: { createdAt: "asc" } } },
  });
  if (rows.length > MAX_ROWS) return new NextResponse(`A file can hold at most ${MAX_ROWS.toLocaleString("en-US")} contacts. Narrow the list with the filters.`, { status: 413 });

  const header = ["Serial", "Code", "Name", "Company", "Job title", ...KINDS.map((k) => CONTACT_IDENTIFIER_LABEL[k]), "Address", "City", "Country", "Map", "Birthday", "Source", "Tags", "Agreed to offers", "Notes", "Added"];
  const data = rows.map((c) => [
    formatContactSerial(c.serial),
    c.code ?? "",
    c.name ?? "",
    c.company ?? "",
    c.jobTitle ?? "",
    ...KINDS.map((k) => c.identifiers.filter((i) => i.kind === k).map((i) => i.value).join(", ")),
    c.address ?? "",
    c.city ?? "",
    c.country ?? "",
    c.mapUrl ?? "",
    c.birthday ?? "",
    CONTACT_SOURCE_LABEL[c.source],
    c.tags.join(", "),
    CONTACT_CONSENT_LABEL[c.consent],
    c.notes ?? "",
    c.createdAt.toISOString().slice(0, 10),
  ].map(cell));

  const name = `contacts-${new Date().toISOString().slice(0, 10)}`;
  if (body.format === "csv") {
    const escape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = "﻿" + [header, ...data].map((r) => r.map(escape).join(",")).join("\r\n");
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` } });
  }
  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Contacts");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${name}.xlsx"` } });
}
