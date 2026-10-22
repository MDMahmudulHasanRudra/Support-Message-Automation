import { NextResponse } from "next/server";
import { prisma as platformPrisma } from "@support-automation/db";
import { normalizeHostname } from "@support-automation/shared";

/**
 * Caddy's on-demand TLS question (SAAS_PLATFORM_PLAN.md §3.4): "may I get a certificate for
 * `?domain=`?" Caddy calls this on 127.0.0.1 before it ever contacts Let's Encrypt, so a name
 * nobody configured can never make the server request certificates (which would also burn the
 * rate limit). Yes for a customer domain whose DNS and reachability were verified (VERIFIED or
 * ACTIVE) and for the configured admin hostnames; no for everything else, DISABLED included.
 * Answers only "yes"/"no" — nothing about which customer.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const host = normalizeHostname(new URL(request.url).searchParams.get("domain") ?? "");
  if (!host) return new NextResponse("no", { status: 404 });
  const [domain, settings] = await Promise.all([
    platformPrisma.customerDomain.findUnique({ where: { hostname: host }, select: { status: true } }),
    platformPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { adminHostnames: true } }),
  ]);
  const allowed = (domain && (domain.status === "VERIFIED" || domain.status === "ACTIVE")) || Boolean(settings?.adminHostnames.includes(host));
  return new NextResponse(allowed ? "yes" : "no", { status: allowed ? 200 : 404 });
}
