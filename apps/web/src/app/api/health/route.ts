import { NextResponse } from "next/server";
import { checkDatabaseConnection } from "@support-automation/db";

export async function GET() {
  const dbConnected = await checkDatabaseConnection();

  return NextResponse.json(
    { status: dbConnected ? "ok" : "degraded", dbConnected },
    { status: dbConnected ? 200 : 503 },
  );
}
