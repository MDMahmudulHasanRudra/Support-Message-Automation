/**
 * Runs once when the app server starts (Next.js instrumentation). Starts the Smart Bulk Import
 * processor (SMART_IMPORT.md) in the app process — never in the browser bundle, never at build time.
 * SMART_IMPORT_PROCESSOR_DISABLED=true leaves it off (queued imports then simply wait).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SMART_IMPORT_PROCESSOR_DISABLED === "true") return;
  const { startSmartImportProcessor } = await import("./server/smartImportProcessor");
  startSmartImportProcessor();
}
