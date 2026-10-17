import countryToCurrency from "country-to-currency";
import { CLIENT_STATUS_LABELS, dhakaToday, addDuration, SUBSCRIPTION_KIND_LABELS, type SubscriptionKind } from "@support-automation/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { countryName, countryOptions } from "@/lib/clientPhone";
import { buildWorkbook, columnLetter, type Cell, type SheetSpec, type Validation } from "@/server/xlsxWriter";

/**
 * The client import template (CLIENTS_V3.md §Import) — what a person downloads, fills in and uploads.
 *
 * Four sheets: **Clients** (first, because the import reads the first sheet — empty, or this project's
 * clients for a round trip), **Example** (filled rows to copy from), **How to fill** (every column: what
 * to write, an example, the accepted values) and **Lists** (the drop-downs' values, from THIS project's
 * own teams, staff and currencies). The header labels are exactly the names `autoMapColumns` recognises,
 * so an untouched template maps itself on upload.
 */

export interface Column {
  header: string;
  required?: boolean;
  width: number;
  /** "text" keeps leading zeros (phones, codes); "date" shows yyyy-mm-dd. */
  format?: "text" | "date";
  what: string;
  example: string;
  accepted?: string;
  /** Lists column letter feeding a drop-down. */
  list?: keyof typeof LIST_COLUMNS;
  strictList?: boolean;
}

const LIST_COLUMNS = { status: "A", subscriptionType: "B", durationUnit: "C", team: "D", staff: "E", country: "F", currency: "G" } as const;

export const IMPORT_TEMPLATE_COLUMNS: readonly Column[] = [
  { header: "Name", required: true, width: 26, what: "The client's or contact person's name. Every row needs one.", example: "Orchid Networks" },
  { header: "Company", width: 22, what: "Company or business name, if different.", example: "Orchid Networks Ltd" },
  { header: "Client code", width: 14, format: "text", what: "Leave EMPTY for new clients — a code (CL-000123) is made for you. Fill it only to keep your own codes, or when updating clients from a downloaded file.", example: "" },
  { header: "Phone", width: 18, format: "text", what: "Mobile number with country code (+8801711000000). A local Bangladeshi 01… number also works. Several? Separate with ;", example: "+8801711122201" },
  { header: "WhatsApp number", width: 18, format: "text", what: "Only if different from Phone. Same format.", example: "" },
  { header: "Email", width: 24, what: "Email address. Several? Separate with ;", example: "billing@orchid.example" },
  { header: "Country", width: 18, what: "Pick from the list (country name), or a two-letter code such as BD or AE.", example: "Bangladesh", list: "country" },
  { header: "Preferred currency", width: 12, what: "Three-letter currency code. A suggestion for new invoices only.", example: "BDT", list: "currency" },
  { header: "Address", width: 26, what: "Street, area or city.", example: "Mirpur 10, Dhaka" },
  { header: "Category", width: 14, what: "Your own grouping, e.g. Reseller, Corporate, Home.", example: "Corporate" },
  { header: "Tags", width: 16, what: "Short labels separated with commas.", example: "vip, dhaka" },
  { header: "Status", width: 12, what: "Pick from the list. Empty = Active.", example: "Active", list: "status", strictList: true, accepted: "Active, Inactive, Pending, Blocked" },
  { header: "Preferred language", width: 14, what: "e.g. Bangla, English, Arabic.", example: "Bangla" },
  { header: "Team", width: 18, what: "Pick a team from the list (your project's active teams).", example: "", list: "team" },
  { header: "Assigned staff", width: 20, what: "Who looks after this client. Pick a name, or write their phone number if two people share a name. Must be in the Team above when both are filled.", example: "", list: "staff" },
  { header: "Sold by", width: 20, what: "Who sold the subscription / brought the client in. Pick a name from the list (or their phone number).", example: "", list: "staff" },
  { header: "Service / plan", width: 18, what: "What they bought, e.g. Tiger IPTV. Fill this (and Start date + Duration or Expiry date) to add their current subscription; leave all four empty for no subscription.", example: "Tiger IPTV" },
  { header: "Subscription type", width: 14, what: "Pick from the list. Empty = Paid.", example: "Paid", list: "subscriptionType", strictList: true, accepted: "Paid, Trial, Demo, Complimentary" },
  { header: "Start date", width: 13, format: "date", what: "When the service started: 2026-10-17 or 17/10/2026 (day first).", example: "" },
  { header: "Duration", width: 10, what: "A whole number, with the unit in the next column. Or leave empty and fill Expiry date instead.", example: "1" },
  { header: "Duration unit", width: 12, what: "Pick from the list. Empty = Months.", example: "Months", list: "durationUnit", strictList: true, accepted: "Days, Weeks, Months, Years" },
  { header: "Expiry date", width: 13, format: "date", what: "Only when there is no Duration: the day the service expires (2026-11-17 or 17/11/2026).", example: "" },
  { header: "Facebook reference", width: 18, what: "Messenger page-scoped id or profile reference, if you have one.", example: "" },
  { header: "Instagram handle", width: 16, what: "Instagram username, with or without @.", example: "" },
  { header: "Telegram", width: 14, what: "Telegram username.", example: "" },
];

/** A cell tip (≤255 characters, Excel's own limit). */
const tip = (c: Column) => (c.what.length > 250 ? `${c.what.slice(0, 247)}…` : c.what);

export interface TemplateRows {
  rows: string[][];
  truncated: boolean;
}

/** This project's current clients as template rows (a round trip: edit, then re-upload with Update). */
async function currentClientRows(where: Prisma.ClientWhereInput, limit: number): Promise<TemplateRows> {
  const clients = await prisma.client.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      code: true,
      name: true,
      companyName: true,
      status: true,
      category: true,
      tags: true,
      preferredLanguage: true,
      address: true,
      country: true,
      preferredCurrency: true,
      assignedTeam: { select: { name: true } },
      assignedMember: { select: { name: true } },
      soldByMember: { select: { name: true } },
      channels: { select: { kind: true, value: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      currentSubscription: { select: { service: true, kind: true, startDate: true, endDate: true, soldByName: true } },
    },
  });
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const rows = clients.slice(0, limit).map((c) => {
    const of = (kind: string) => c.channels.filter((ch) => ch.kind === kind).map((ch) => ch.value).join("; ");
    const phone = of("PHONE");
    const wa = of("WHATSAPP");
    const sub = c.currentSubscription;
    const values: Record<string, string> = {
      Name: c.name,
      Company: c.companyName ?? "",
      "Client code": c.code,
      Phone: phone,
      "WhatsApp number": wa === phone ? "" : wa,
      Email: of("EMAIL"),
      Country: c.country ? (countryName(c.country) ?? c.country) : "",
      "Preferred currency": c.preferredCurrency ?? "",
      Address: c.address ?? "",
      Category: c.category ?? "",
      Tags: c.tags.join(", "),
      Status: CLIENT_STATUS_LABELS[c.status as keyof typeof CLIENT_STATUS_LABELS] ?? c.status,
      "Preferred language": c.preferredLanguage ?? "",
      Team: c.assignedTeam?.name ?? "",
      "Assigned staff": c.assignedMember?.name ?? "",
      "Sold by": sub?.soldByName ?? c.soldByMember?.name ?? "",
      "Service / plan": sub?.service ?? "",
      "Subscription type": sub ? (SUBSCRIPTION_KIND_LABELS[sub.kind as SubscriptionKind] ?? sub.kind).replace(" subscription", "") : "",
      "Start date": sub ? day(sub.startDate) : "",
      Duration: "",
      "Duration unit": "",
      "Expiry date": sub ? day(sub.endDate) : "",
      "Facebook reference": of("MESSENGER"),
      "Instagram handle": of("INSTAGRAM"),
      Telegram: of("TELEGRAM"),
    };
    return IMPORT_TEMPLATE_COLUMNS.map((col) => values[col.header] ?? "");
  });
  return { rows, truncated: clients.length > limit };
}

export async function buildClientImportTemplate(options: { clientsWhere: Prisma.ClientWhereInput | null; projectName: string; maxRows: number }): Promise<{ bytes: Buffer; truncated: boolean }> {
  const [teams, members, currencies] = await Promise.all([
    prisma.team.findMany({ where: { status: "ACTIVE" }, select: { name: true }, orderBy: { name: "asc" } }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { name: true, team: { select: { name: true } } }, orderBy: { name: "asc" } }),
    prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true }, orderBy: { code: "asc" } }),
  ]);
  const enabled = currencies.map((c) => c.code);
  const allCurrencies = [...new Set([...enabled, ...Object.values(countryToCurrency as Record<string, string>).sort()])];
  const lists: Record<keyof typeof LIST_COLUMNS, string[]> = {
    status: ["Active", "Inactive", "Pending", "Blocked"],
    subscriptionType: ["Paid", "Trial", "Demo", "Complimentary"],
    durationUnit: ["Days", "Weeks", "Months", "Years"],
    team: teams.map((t) => t.name),
    staff: [...new Set(members.map((m) => m.name))],
    country: countryOptions().map((c) => c.name),
    currency: allCurrencies,
  };

  const dataRows = options.maxRows + 1;
  const validations: Validation[] = IMPORT_TEMPLATE_COLUMNS.map((col, i) => {
    const letter = columnLetter(i);
    const range = `${letter}2:${letter}${dataRows}`;
    const values = col.list ? lists[col.list] : [];
    return {
      range,
      list: col.list && values.length ? `'Lists'!$${LIST_COLUMNS[col.list]}$2:$${LIST_COLUMNS[col.list]}$${values.length + 1}` : undefined,
      errorStyle: col.strictList ? "stop" : "warning",
      promptTitle: col.header + (col.required ? " (required)" : ""),
      prompt: tip(col),
    } satisfies Validation;
  });

  const header: Cell[] = IMPORT_TEMPLATE_COLUMNS.map((c) => ({ value: c.header, style: c.required ? "headerRequired" : "header" }));
  const filled = options.clientsWhere ? await currentClientRows(options.clientsWhere, options.maxRows) : { rows: [], truncated: false };
  const clientsSheet: SheetSpec = {
    name: "Clients",
    rows: [header, ...filled.rows.map((r) => r.map((v, i) => ({ value: v, style: IMPORT_TEMPLATE_COLUMNS[i]!.format })))],
    widths: IMPORT_TEMPLATE_COLUMNS.map((c) => c.width),
    columnStyles: IMPORT_TEMPLATE_COLUMNS.map((c) => (c.format === "text" ? "text" : c.format === "date" ? "date" : undefined)),
    freezeRows: 1,
    freezeCols: 1,
    headerHeight: 30,
    validations,
  };

  // Example rows: fictional, using this project's own team and staff names where they exist.
  const today = dhakaToday(new Date());
  const team = lists.team[0] ?? "";
  const staff = members.find((m) => m.team?.name === team)?.name ?? lists.staff[0] ?? "";
  const examples: Record<string, string>[] = [
    { Name: "Orchid Networks", Company: "Orchid Networks Ltd", Phone: "+8801711122201", Email: "billing@orchid.example", Country: "Bangladesh", "Preferred currency": "BDT", Address: "Mirpur 10, Dhaka", Category: "Corporate", Tags: "vip, dhaka", Status: "Active", "Preferred language": "Bangla", Team: team, "Assigned staff": staff, "Sold by": staff, "Service / plan": "Tiger IPTV", "Subscription type": "Paid", "Start date": today, Duration: "12", "Duration unit": "Months" },
    { Name: "Nova Commerce", Phone: "+971501112201", "WhatsApp number": "+971551112299", Country: "United Arab Emirates", "Preferred currency": "AED", Category: "Reseller", Status: "Active", "Sold by": staff, "Service / plan": "Premium TV", "Subscription type": "Trial", "Start date": today, "Expiry date": addDuration(today, 7, "DAY") },
    { Name: "Rahim Uddin", Phone: "01811222233", Email: "rahim@example.com; rahim.work@example.com", Country: "BD", Address: "Chattogram", Tags: "home", "Preferred language": "Bangla" },
  ];
  const exampleSheet: SheetSpec = {
    name: "Example",
    rows: [header, ...examples.map((e) => IMPORT_TEMPLATE_COLUMNS.map((c) => ({ value: e[c.header] ?? "", style: "example" as const })))],
    widths: IMPORT_TEMPLATE_COLUMNS.map((c) => c.width),
    freezeRows: 1,
    freezeCols: 1,
    headerHeight: 30,
  };

  const guide: SheetSpec = {
    name: "How to fill",
    widths: [22, 11, 70, 24, 34],
    rows: [
      [{ value: `Client import — ${options.projectName}`, style: "title" }],
      [{ value: "1. Fill one client per row on the Clients sheet (the first sheet). Do not rename the column headers; you may delete columns you do not use.", style: "muted" }],
      [{ value: "2. Click any cell to see a tip for that column. Columns with a drop-down only accept the listed values (Lists sheet).", style: "muted" }],
      [{ value: "3. Upload the file on Clients → Import Clients. You see a preview and every problem row BEFORE anything is saved.", style: "muted" }],
      [{ value: "4. Already have the client (same phone, email or code)? At the confirmation choose Skip, Update or Create anyway. Nothing is merged silently.", style: "muted" }],
      [{ value: "To update many clients at once: download “Template with my clients”, edit the rows, upload it and choose Update.", style: "muted" }],
      [{ value: `Limits: up to 2,000 rows and 2 MB per file. Only Name is required. Phones keep their leading 0 because those columns are formatted as text.`, style: "muted" }],
      [],
      ["Column", "Required", "What to write", "Example", "Accepted values"].map((v) => ({ value: v, style: "header" as const })),
      ...IMPORT_TEMPLATE_COLUMNS.map((c) => [
        { value: c.header, style: "bold" as const },
        { value: c.required ? "Required" : "Optional", style: "wrap" as const },
        { value: c.what, style: "wrap" as const },
        { value: c.example || examples.map((e) => e[c.header]).find(Boolean) || "", style: "wrap" as const },
        {
          value: c.accepted ?? (c.list === "team" ? `Your teams: ${lists.team.join(", ") || "(none yet — add on WhatsApp → Teams)"}` : c.list === "staff" ? "Names from the Lists sheet (your active team members), or their phone number" : c.list === "country" ? "Country names from the Lists sheet, or a two-letter code" : c.list === "currency" ? `Three-letter codes${enabled.length ? `; your billing currencies: ${enabled.join(", ")}` : ""}` : c.format === "date" ? "2026-10-17, 17/10/2026, 17-10-2026, 17 Oct 2026" : "Free text"),
          style: "wrap" as const,
        },
      ]),
    ],
  };

  const longest = Math.max(...Object.values(lists).map((v) => v.length));
  const listsSheet: SheetSpec = {
    name: "Lists",
    widths: [12, 16, 14, 22, 24, 28, 12],
    freezeRows: 1,
    rows: [
      ["Status", "Subscription type", "Duration unit", "Team", "Staff (sold by / assigned)", "Country", "Currency"].map((v) => ({ value: v, style: "header" as const })),
      ...Array.from({ length: longest }, (_, i) => (Object.keys(LIST_COLUMNS) as Array<keyof typeof LIST_COLUMNS>).map((k) => lists[k][i] ?? "")),
    ],
  };

  return { bytes: buildWorkbook([clientsSheet, exampleSheet, guide, listsSheet], `Client import template — ${options.projectName}`), truncated: filled.truncated };
}
