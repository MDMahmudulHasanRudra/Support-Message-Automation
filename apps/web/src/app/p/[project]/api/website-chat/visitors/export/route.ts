import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { exportWebsiteVisitors, type VisitorFilters } from "@/server/websiteChat";

const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  // A leading = + - @ would run as a formula when the file is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The Visitors list as a file: the same filters, this project only, behind the page's own key. */
export async function GET(request: NextRequest) {
  if (!(await getSession())) return new NextResponse(null, { status: 401 });
  const access = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in access) return new NextResponse(access.denied, { status: 403 });
  const p = request.nextUrl.searchParams;
  const contact = p.get("contact");
  const filters: VisitorFilters = { q: p.get("q") ?? "", widget: p.get("widget") ?? "", contact: contact === "yes" || contact === "no" ? contact : "" };
  const rows = await exportWebsiteVisitors(filters);
  const header = ["Name", "Phone", "Email", "Signed in", "Widget", "Answers", "First page", "Last page", "Referrer", "UTM source", "UTM medium", "UTM campaign", "Invitation", "Device", "System", "Browser", "Language", "Time zone", "Visits", "First seen", "Last seen", "Consent"];
  const lines = rows.map((v) => {
    const answers = Array.isArray(v.customAnswers) ? (v.customAnswers as Array<{ label: string; value: string }>).map((a) => `${a.label}: ${a.value}`).join("; ") : "";
    return [v.name, v.phone ?? v.typedPhone, v.email, v.verifiedExternalId ? "Yes" : "No", v.connection.name, answers, v.firstPageUrl, v.pageUrl, v.referrer, v.utmSource, v.utmMedium, v.utmCampaign, v.startedFrom, v.device, v.os, v.browser, v.language, v.timeZone, v.visitCount, v.createdAt, v.lastSeenAt, v.consentAt].map(cell).join(",");
  });
  return new NextResponse(`\ufeff${[header.join(","), ...lines].join("\r\n")}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="website-visitors.csv"', "Cache-Control": "no-store" },
  });
}
