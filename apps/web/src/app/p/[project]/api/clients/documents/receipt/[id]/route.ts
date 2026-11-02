import type { NextRequest } from "next/server";
import { serveClientDocument } from "@/server/clientDocumentRoute";

/** The receipt as a document (CLIENT_CRM_V7.md §3): `?format=html` (default) or `?format=pdf`. Checks in `serveClientDocument`. */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return serveClientDocument("receipt", request, (await params).id);
}
