import { NextResponse } from "next/server";
import { prisma as platformPrisma } from "@support-automation/db";
import { normalizeHostname } from "@support-automation/shared";
import { domainCheckAnswer } from "@/server/domainVerification";
import { visitedHost } from "@/lib/projectPaths";

/**
 * Proof that a hostname reaches THIS deployment (SAAS_PLATFORM_PLAN.md §3.5, step "reaches the
 * app"). The domain check requests `http://<hostname>/api/platform/domain-check` and expects a hash
 * of that domain's own verification token back. A hostname that resolves to the right IP but is
 * served by something else (another app on the box, a stale proxy rule) does not answer it.
 * Reveals nothing: an unknown hostname gets a 404, a known one only a hash of its own token.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const host = normalizeHostname(visitedHost(request.headers));
  if (!host) return new NextResponse("unknown", { status: 404 });
  const domain = await platformPrisma.customerDomain.findUnique({ where: { hostname: host }, select: { verificationToken: true, status: true } });
  if (!domain || domain.status === "DISABLED") return new NextResponse("unknown", { status: 404 });
  return new NextResponse(domainCheckAnswer(domain.verificationToken), { status: 200, headers: { "Cache-Control": "no-store" } });
}
