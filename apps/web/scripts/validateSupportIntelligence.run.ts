/**
 * READ-ONLY real-data validation for Support Intelligence (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §J).
 *
 * For a few real groups and a short period it prints every step side by side —
 *   message → who sent it → signals read from the text → support session → case → owner, hand-off,
 *   resolution, complexity → human wait
 * — into a Markdown file a person compares, line by line, against the conversation in WhatsApp.
 * It runs the SAME loader and pure model the reports use, so what it shows is what the reports show.
 *
 * It cannot write:
 *   - the connection is forced to ONE pooled connection and switched to READ ONLY before anything
 *     else (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`), which Postgres enforces —
 *     any write fails;
 *   - it checks `transaction_read_only` is on before reading and again at the end, and proves it by
 *     making Postgres refuse a no-op UPDATE (`WHERE false`) on the same connection — otherwise it
 *     refuses to run;
 *   - it calls only read functions. The only file it writes is the Markdown report on this machine.
 * Prefer running it with a database user that has only SELECT rights, too.
 *
 * Usage (from the repository root):
 *
 *   VALIDATION_DATABASE_URL="postgresql://…"            # the database to read
 *   VALIDATE_PROJECT=isp-digital                         # project slug
 *   VALIDATE_FROM=2026-10-01 VALIDATE_TO=2026-10-03      # Asia/Dhaka dates, at most 14 days
 *   VALIDATE_GROUPS="1203…@g.us,1203…@g.us"              # WhatsApp group ids (or VALIDATE_GROUP_NAMES="ABC ISP,Dhaka Fiber")
 *   VALIDATE_OUT=support-intelligence-validation.md      # optional
 *   pnpm --filter @support-automation/web validate:intelligence
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";

const MAX_GROUPS = 10;
const MAX_DAYS = 14;

const env = (name: string) => (process.env[name] ?? "").trim();

function readOnlyUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "60");
  return url.toString();
}

it("validates Support Intelligence against real conversations (read-only)", async () => {
  const source = env("VALIDATION_DATABASE_URL");
  if (!source) throw new Error("Set VALIDATION_DATABASE_URL to the database to read.");
  // Before any module that creates a Prisma client is imported.
  process.env.DATABASE_URL = readOnlyUrl(source);

  const { prisma: platform } = await import("@support-automation/db");
  await platform.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const assertReadOnly = async () => {
    const [row] = await platform.$queryRawUnsafe<Array<{ transaction_read_only: string }>>("SHOW transaction_read_only");
    if (row?.transaction_read_only !== "on") throw new Error("The connection is not read-only; refusing to continue.");
  };
  await assertReadOnly();
  // Prove it on this very connection: Postgres must refuse even a statement that would change
  // nothing (WHERE false), because a read-only transaction rejects every UPDATE.
  const refused = await platform.$executeRawUnsafe(`UPDATE "Project" SET "name" = "name" WHERE false`).then(
    () => false,
    () => true,
  );
  if (!refused) throw new Error("A write was not refused; the connection is not read-only. Nothing was read.");

  const slug = env("VALIDATE_PROJECT") || "isp-digital";
  const from = env("VALIDATE_FROM");
  const to = env("VALIDATE_TO") || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Set VALIDATE_FROM and VALIDATE_TO as YYYY-MM-DD (Asia/Dhaka).");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) throw new Error(`At most ${MAX_DAYS} days — this is for reading conversations line by line.`);

  const project = await platform.project.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, status: true } });
  if (!project) throw new Error(`No project "${slug}".`);

  let groupKeys = env("VALIDATE_GROUPS").split(",").map((s) => s.trim()).filter(Boolean);
  const names = env("VALIDATE_GROUP_NAMES").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length) {
    const found = await platform.whatsAppGroup.findMany({
      where: { projectId: project.id, OR: names.map((n) => ({ name: { contains: n, mode: "insensitive" as const } })) },
      select: { whatsappGroupId: true },
    });
    groupKeys = [...new Set([...groupKeys, ...found.map((g) => g.whatsappGroupId)])];
  }
  if (groupKeys.length === 0) throw new Error("Name the groups: VALIDATE_GROUPS (WhatsApp ids) or VALIDATE_GROUP_NAMES.");
  if (groupKeys.length > MAX_GROUPS) throw new Error(`At most ${MAX_GROUPS} groups at a time (${groupKeys.length} matched).`);

  const { runWithProject } = await import("@/server/projectContext");
  const { loadReportContext } = await import("@/server/reports/context");
  const { loadIntelligence } = await import("@/server/intelligence/loader");
  const shared = await import("@support-automation/shared");
  const { CASE_STATE_LABELS, INTEL_ACTOR_LABELS, signalsOf, formatDhakaMoment } = shared;

  const out: string[] = [];
  await runWithProject(project, async () => {
    const ctx = await loadReportContext({ period: "custom", from, to, groups: groupKeys.join(",") }, new Date());
    const intel = await loadIntelligence(ctx);
    const who = (m: { actor: keyof typeof INTEL_ACTOR_LABELS; memberId: string | null }) =>
      m.actor === "MEMBER" ? (intel.memberNames.get(m.memberId ?? "") ?? "Team member") : INTEL_ACTOR_LABELS[m.actor];
    const t = (ms: number | null) => (ms === null ? "—" : formatDhakaMoment(ms));
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

    out.push(`# Support Intelligence validation — ${project.name}`);
    out.push("");
    out.push(`Period ${from} – ${to} (Asia/Dhaka) · generated ${t(Date.now())} · read-only connection verified.`);
    out.push("");
    out.push(`Data health: **${ctx.dataHealth.label}** — ${ctx.dataHealth.headline}`);
    for (const w of ctx.dataHealth.warnings) out.push(`- ${w}`);
    out.push("");
    out.push("For each group, open the conversation in WhatsApp beside this file and mark every case: does the derived state, owner, hand-off and resolution match what really happened? Write what differs. A mismatch means the rule is wrong — stop and report it before the scores are relied on.");

    for (const groupKey of groupKeys) {
      const msgs = intel.messages.filter((m) => m.groupKey === groupKey).sort((a, b) => a.ts - b.ts);
      out.push("", `## ${ctx.groupName(groupKey)}`, "", `\`${groupKey}\` · ${msgs.length} messages loaded (including the look-behind/ahead window)`, "");
      out.push("### Timeline", "", "| Time | Sender | Text (only when a catalogue could match) | Signals read |", "|---|---|---|---|");
      for (const m of msgs) {
        const s = signalsOf(m);
        const flags = [
          s.handoff ? `hand-off ${s.handoff}` : "",
          s.employeeResolved ? "states fix" : "",
          s.customerConfirm ? "customer confirms" : "",
          s.stillBroken ? "says not working" : "",
          s.thanks ? "thanks" : "",
          s.praise ? "praise" : "",
          s.preference ? "preference" : "",
          s.genericTeam ? "to everyone" : "",
          s.acknowledgement ? "acknowledgement" : "",
          m.quotedKey ? "quotes a message" : "",
          m.mentionedMemberIds.length ? "@mentions" : "",
        ].filter(Boolean);
        out.push(`| ${t(m.ts)} | ${esc(who(m))} | ${m.text ? esc(m.text) : "_(not read)_"} | ${flags.join(", ") || "—"} |`);
      }
      const cases = intel.allCases.filter((c) => c.groupKey === groupKey);
      out.push("", `### Cases (${cases.length})`);
      for (const c of cases) {
        out.push(
          "",
          `**${t(c.openedAt)} → ${t(c.lastAt)} · ${CASE_STATE_LABELS[c.state]}**${c.openedAt < ctx.rangeStart ? " _(opened before the period — context only)_" : ""}`,
          "",
          `- Resolution: ${c.resolution ? `${c.resolution.confidence} — ${c.resolution.basis} Evidence: "${esc(c.resolution.evidence.text)}" (${t(c.resolution.evidence.at)})` : c.state === "ABANDONED" ? "none — no further contact (LOW, not counted)" : "none"}`,
          `- Owner: ${c.owner ? `${intel.memberNames.get(c.owner.memberId) ?? c.owner.memberId} (${c.owner.confidence}) — ${c.owner.reasons.join("; ")}` : "no employee replied"}`,
          `- Hand-offs: ${c.handoffs.length ? c.handoffs.map((h) => `${who({ actor: h.actor, memberId: h.memberId })} ${h.confidence} at ${t(h.at)}${h.returned ? ", came back afterwards" : ", did not come back"}`).join("; ") : "none"}`,
          `- Complexity: ${c.complexity}${c.complexityReasons.length ? ` — ${c.complexityReasons.join("; ")}` : ""}`,
          `- First human reply: ${c.firstHumanReplyAt ? `${t(c.firstHumanReplyAt)} by ${c.firstHumanReplyBy ? who(c.firstHumanReplyBy) : "?"}` : "none"} · reopened: ${c.reopened ? `yes (${t(c.reopenedAt)})` : "no"} · SLA escalation: ${c.escalated ? "yes" : "no"}`,
          "- Matches WhatsApp?  [ ] yes  [ ] no — notes:",
        );
      }
      const sessions = intel.sessions.filter((s) => s.groupKey === groupKey);
      out.push("", `### Sessions (${sessions.length})`, "", "| Employee | Start | End | Messages | Case state |", "|---|---|---|---|---|");
      for (const s of sessions) out.push(`| ${esc(intel.memberNames.get(s.memberId) ?? s.memberId)} | ${t(s.start)} | ${t(s.end)} | ${s.messages} | ${s.state === "NO_CASE" ? "no case" : CASE_STATE_LABELS[s.state]} |`);
      const waits = intel.waits.filter((w) => w.groupKey === groupKey);
      out.push("", `### Human waits (${waits.length})`, "", "| Asked | Status | Waited | First automated reply | Answered by |", "|---|---|---|---|---|");
      for (const w of waits) {
        out.push(
          `| ${t(w.askedAt)} | ${w.status} | ${w.waitSeconds === null ? "—" : `${Math.round(w.waitSeconds / 60)} min`} | ${w.automatedFirstAt ? `${INTEL_ACTOR_LABELS[w.automatedFirstActor!]} ${t(w.automatedFirstAt)}` : "—"} | ${w.repliedBy ? esc(who({ actor: w.repliedBy.actor, memberId: w.repliedBy.memberId })) : "—"} |`,
        );
      }
      const thanks = intel.appreciation.filter((a) => a.groupKey === groupKey);
      if (thanks.length) {
        out.push("", "### Appreciation", "", "| When | Kind | For | Confidence | Why | Message |", "|---|---|---|---|---|---|");
        for (const a of thanks) out.push(`| ${t(a.at)} | ${a.kind} | ${a.memberId ? esc(intel.memberNames.get(a.memberId) ?? a.memberId) : "nobody"} | ${a.confidence ?? "—"} | ${esc(a.attribution)} | ${esc(a.text)} |`);
      }
    }

    out.push("", "## Scenario checklist (request §29)", "");
    for (const s of [
      "Simple support case", "Multi-message support case", "Customer waiting", "Employee waiting for customer", "Developer escalation",
      "Employee returns after developer fix", "Customer confirms resolution", "Customer thanks employee", "Customer requests same employee again",
      "Multiple groups handled concurrently", "AI reply", "Rule reply", "Human reply", "Missed support", "Reopened issue",
      "Outside-duty support", "Collection gap", "Business/unattributed reply",
    ]) out.push(`- [ ] ${s} — found in: ______ · matches: [ ] yes [ ] no — notes:`);
  });

  await assertReadOnly();
  const file = resolve(env("VALIDATE_OUT") || `support-intelligence-validation-${slug}-${from}.md`);
  writeFileSync(file, out.join("\n"), "utf8");
  console.log(`\nValidation report written to ${file}\n`);
  await platform.$disconnect();
});
