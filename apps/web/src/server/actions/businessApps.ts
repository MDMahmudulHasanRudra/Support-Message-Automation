"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { businessAppDefinition, isBusinessAppKey, validateLaunchTicket, type ConnectRequest } from "@support-automation/shared";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  authorizeBusinessAppLaunch,
  businessAppAdapterFor,
  businessAppEmbedUrl,
  connectBusinessApp,
  installBusinessApp,
  setBusinessAppEnabled,
} from "@/server/businessApps";

/**
 * Business Apps actions (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md). Every Server Action is a public endpoint,
 * so each makes its own check: adding, connecting, disabling and enabling an app is a Main Admin's
 * (`projects.manage`, the same key that creates projects); launching is `business_apps.open` inside the
 * project, decided by `authorizeBusinessAppLaunch`. Entitlement boundary: today a Main Admin may add any
 * INSTALLABLE app; when Business Apps are billed, the plan check goes in `installBusinessApp` and nowhere else.
 */

export interface BusinessAppActionResult {
  error?: string;
  success?: string;
}

const MANAGE_DENIED = "Managing Business Apps needs the “Manage Projects and Project Access” permission.";

async function requireManage(): Promise<{ session: Session } | { denied: string }> {
  const session = await requireSession();
  return (await hasPermission(session, "projects.manage")) ? { session } : { denied: MANAGE_DENIED };
}

function revalidateAdmin(projectId?: string) {
  revalidatePath("/admin/business-apps");
  if (projectId) revalidatePath(`/admin/projects/${projectId}`);
}

export async function addBusinessApp(projectId: string, appKey: string): Promise<BusinessAppActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const result = await installBusinessApp(projectId, appKey, access.session);
  if (!result.ok) return { error: result.error };
  const name = businessAppDefinition(appKey as Parameters<typeof businessAppDefinition>[0]).name;
  await logSystemEvent("INFO", "business_apps", `Business App "${name}" added to a project`, { projectId, appKey, installationId: result.installationId, by: access.session.username }, {
    actorUserId: access.session.userId,
    targetType: "ProjectAppInstallation",
    targetId: result.installationId,
  });
  revalidateAdmin(projectId);
  return { success: `${name} was added. It is waiting to connect; nothing has been sent to it.` };
}

/** What the Connect dialog may ask for, re-read on the server: the browser's values are never trusted as typed. */
export interface ConnectInput {
  mode: "PROVISION_NEW" | "LINK_EXISTING" | "RECHECK";
  currency?: string;
  workspaceId?: string;
}

function parseConnectInput(input: ConnectInput | undefined): ConnectRequest | { error: string } {
  const mode = input?.mode ?? "RECHECK";
  if (mode === "RECHECK") return { mode };
  if (mode === "PROVISION_NEW") {
    const currency = (input?.currency ?? "").trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) return { error: "The currency must be a three-letter code, such as BDT or USD." };
    return { mode, currency: currency || null };
  }
  if (mode === "LINK_EXISTING") {
    const workspaceId = (input?.workspaceId ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
      return { error: "Paste the Commerce workspace id (it looks like 621ac1c0-9b9b-4094-ad6c-7151bd582fce)." };
    }
    return { mode, externalWorkspaceId: workspaceId };
  }
  return { error: "Unknown way to connect." };
}

export async function connectBusinessAppAction(installationId: string, projectId: string, input?: ConnectInput): Promise<BusinessAppActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const request = parseConnectInput(input);
  if ("error" in request) return { error: request.error };
  const result = await connectBusinessApp(installationId, access.session, request);
  await logSystemEvent(result.ok ? "INFO" : "WARN", "business_apps", result.ok ? "Business App connected" : "Business App connection check did not succeed", {
    installationId,
    projectId,
    mode: request.mode,
    by: access.session.username,
    ...(result.ok ? {} : { reason: result.error }),
  });
  revalidateAdmin(projectId);
  return result.ok ? { success: result.message } : { error: result.error };
}

export async function setBusinessAppEnabledAction(installationId: string, projectId: string, enabled: boolean): Promise<BusinessAppActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const result = await setBusinessAppEnabled(installationId, enabled, access.session);
  if (result.ok) {
    await logSystemEvent("WARN", "business_apps", enabled ? "Business App enabled" : "Business App disabled", { installationId, projectId, by: access.session.username });
  }
  revalidateAdmin(projectId);
  return result.ok ? { success: result.message } : { error: result.error };
}

/**
 * Open an app from the workspace. The same decision as the launcher page, then the app's adapter is asked
 * for a short-lived, single-use launch — never a host cookie or a long-lived credential. No adapter exists
 * yet, so this answers honestly that the app cannot be opened (WAITING FOR COMMERCE).
 */
export async function launchBusinessApp(appKey: string): Promise<{ error?: string; redirectUrl?: string }> {
  const decision = await authorizeBusinessAppLaunch(appKey);
  if (!decision.ok) return { error: decision.message };
  if (!isBusinessAppKey(appKey)) return { error: "Unknown Business App." };
  const adapter = businessAppAdapterFor(decision.app.key);
  if (!adapter) return { error: `${decision.app.name} has not published its sign-in hand-off yet, so it cannot be opened from here. Nothing was sent to it.` };
  const ticket = await adapter.createLaunch(
    // No credential is handed to a launch: a hand-off is the app's own single-use code, never the host's key.
    { projectId: decision.project.id, appKey: decision.app.key, externalWorkspaceId: decision.installation.externalWorkspaceId, contractVersion: decision.installation.contractVersion, credential: null },
    {
      // Pseudonymous and stable per installation: the app never learns the host's own user id.
      subject: createHash("sha256").update(`${decision.installation.id}:${decision.session.userId}`).digest("hex"),
      displayName: decision.session.name || decision.session.username,
      scopes: ["app.open"],
    },
  );
  if (!ticket.ok) return { error: ticket.error.message };
  // Only an address on the app's approved origin, secure, and a ticket that expires soon but has not yet.
  const approved = businessAppEmbedUrl(decision.app.key)?.origin;
  if (!approved) return { error: `${decision.app.name}'s address is not configured on this server, so it was not opened.` };
  const checked = validateLaunchTicket(ticket.data, approved);
  if (!checked.ok) {
    const why = { INVALID_URL: "an address that is not valid", NOT_SECURE: "an address that is not secure", WRONG_ORIGIN: "an address outside its approved origin", EXPIRED: "a hand-off that has already expired", TOO_LONG_LIVED: "a hand-off that stays valid for too long" }[checked.refusal];
    return { error: `${decision.app.name} answered with ${why}, so it was not opened.` };
  }
  const url = checked.url;
  await logSystemEvent("INFO", "business_apps", "Business App opened", { appKey, projectId: decision.project.id, by: decision.session.username });
  return { redirectUrl: url.toString() };
}
