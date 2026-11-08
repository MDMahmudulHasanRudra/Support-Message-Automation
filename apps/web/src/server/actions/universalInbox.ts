"use server";

import { isInboxScope, parseInboxFilterSet } from "@support-automation/shared";
import { getSession } from "@/server/auth";
import { bulkUpdateConversations, type BulkOp, type BulkResult } from "@/server/actions/inbox";
import { runWithProject } from "@/server/projectContext";
import { forgetUniversalReadings, loadUniversalInbox, universalInboxProjects, type UniversalInboxResult } from "@/server/universalInbox";

/**
 * The All projects inbox's actions (ALL_PROJECTS_INBOX.md). Each is a public endpoint and starts from the session: which
 * projects it reads comes from what that person may do now, never from the request.
 */

/** A filter, a search or one channel. Refuses as nothing, because it follows the list's refreshes. */
export async function listUniversalInboxAction(input: { channel: string; filters?: unknown }): Promise<UniversalInboxResult | null> {
  const session = await getSession();
  if (!session || !isInboxScope(input.channel)) return null;
  return loadUniversalInbox(session, { channel: input.channel, filters: parseInboxFilterSet(input.filters) });
}

const BULK_MAX = 200;

/**
 * One change to conversations in several projects. Each project's part goes through that project's ordinary bulk action,
 * with all its checks. A project this person may not use is refused, whatever the request names.
 */
export async function bulkUpdateAcrossProjects(groups: Array<{ projectSlug: string; refs: unknown[] }>, op: BulkOp): Promise<BulkResult | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in to continue." };
  const list = Array.isArray(groups) ? groups : [];
  if (list.reduce((n, g) => n + (Array.isArray(g?.refs) ? g.refs.length : 0), 0) > BULK_MAX) return { error: `Select at most ${BULK_MAX} conversations at a time.` };
  const projects = await universalInboxProjects(session);
  const total: BulkResult = { changed: 0, unchanged: 0, skipped: 0, failed: 0, notes: [] };
  for (const group of list) {
    const project = projects.find((p) => p.slug === group?.projectSlug);
    if (!project) return { error: "One of those conversations is not in a project you can use." };
    const result = await runWithProject(project, () => bulkUpdateConversations(group.refs, op));
    if ("error" in result) {
      total.notes.push(`${project.name}: ${result.error}`);
      total.failed += group.refs.length;
      continue;
    }
    total.changed += result.changed;
    total.unchanged += result.unchanged;
    total.skipped += result.skipped;
    total.failed += result.failed;
    total.notes.push(...result.notes.map((note) => `${project.name}: ${note}`));
  }
  forgetUniversalReadings(session.userId);
  return total;
}
