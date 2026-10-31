/**
 * Runs once when the app server starts (Next.js instrumentation). Starts the Smart Bulk Import
 * processor (SMART_IMPORT.md) and the integrations processor in the app process — never in the browser
 * bundle, never at build time. SMART_IMPORT_PROCESSOR_DISABLED=true / INTEGRATIONS_PROCESSOR_DISABLED=true
 * leave each off (their queued work then simply waits).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SMART_IMPORT_PROCESSOR_DISABLED !== "true") {
    const { startSmartImportProcessor } = await import("./server/smartImportProcessor");
    startSmartImportProcessor();
  }
  // Courier status refresh and outbound webhook delivery (COMMERCE_INTEGRATIONS.md, INTEGRATION_HUB.md).
  if (process.env.INTEGRATIONS_PROCESSOR_DISABLED !== "true") {
    const { startIntegrationsProcessor } = await import("./server/integrationsProcessor");
    startIntegrationsProcessor();
  }
  // Social Studio: sends approved posts to the publishing provider and follows them (SOCIAL_STUDIO.md).
  if (process.env.SOCIAL_PROCESSOR_DISABLED !== "true") {
    const { startSocialProcessor } = await import("./server/socialProcessor");
    startSocialProcessor();
  }
}
