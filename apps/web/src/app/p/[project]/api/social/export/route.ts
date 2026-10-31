import { NextResponse, type NextRequest } from "next/server";
import { isValidTimeZone, zonedLocalToUtc } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { loadSocialAnalytics, socialAnalyticsCsv } from "@/server/social/analytics";

/** The Analytics page's rows as CSV (SOCIAL_STUDIO.md §Analytics): `social.view`, the same loader. */
export const dynamic = "force-dynamic";

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const access = await checkPermission("social.view", "SOCIAL_STUDIO");
  if ("denied" in access) return NextResponse.json({ error: access.denied }, { status: 403 });
  const sp = request.nextUrl.searchParams;
  const tz = isValidTimeZone(sp.get("tz") ?? "") ? sp.get("tz")! : "Asia/Dhaka";
  const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("from") ?? "") ? sp.get("from")! : null;
  const toDay = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("to") ?? "") ? sp.get("to")! : null;
  if (!fromDay || !toDay) return NextResponse.json({ error: "Choose a period." }, { status: 400 });
  const from = zonedLocalToUtc(`${fromDay}T00:00`, tz);
  const to = zonedLocalToUtc(`${addDays(toDay, 1)}T00:00`, tz);
  if (!from || !to || to <= from || to.getTime() - from.getTime() > 400 * 86_400_000) return NextResponse.json({ error: "Choose a period of at most a year." }, { status: 400 });
  const data = await loadSocialAnalytics({ from, to, accountId: sp.get("account") || undefined, campaignId: sp.get("campaign") || undefined });
  return new NextResponse(`﻿${socialAnalyticsCsv(data)}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="social-analytics-${fromDay}-to-${toDay}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
