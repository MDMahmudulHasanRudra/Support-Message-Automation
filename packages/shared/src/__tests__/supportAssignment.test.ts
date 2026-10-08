import { describe, expect, it } from "vitest";
import {
  cleanIgnoredKeywords,
  cleanIgnoredSenders,
  computeSupportAssignmentReport,
  decideReply,
  formatDhakaClock,
  formatResponseTime,
  formatSlaCompliance,
  isOnlyIgnoredWords,
  qualifyCustomerMessage,
  slaOutcome,
  supportAssignmentDedupKey,
  supportAssignmentNoticeVars,
  wasOverdue,
  type ReportCaseInput,
} from "../supportAssignment.js";
import { NOTIFICATION_TEMPLATES, renderNotificationTemplate, validateTemplateBody } from "../notificationTemplates.js";

const KEYWORDS = ["thank you", "thanks", "thanks brother", "ok", "okay", "done", "received", "alright", "ধন্যবাদ"];
const settings = { ignoredKeywords: KEYWORDS, ignoredSenders: [] as string[] };
const qualifies = (body: string, hasMedia = false) => qualifyCustomerMessage({ body, hasMedia, senderPhone: "8801711000000" }, settings).qualifies;

describe("qualification: ignore rules only exclude", () => {
  it.each(["Thanks", "thank you", "Thank you ভাই", "ok", "OK!!", "okay 👍", "ok brother", "thanks brother", "Done.", "ধন্যবাদ ভাইয়া", "received, thanks"])(
    "%s is not a support case",
    (body) => expect(qualifies(body)).toBe(false),
  );

  it.each([
    "ভাই আমার internet এখনও slow",
    "Internet nai",
    "Bill koto?",
    "Package change korte chai",
    "Payment korechi",
    "Router kaj kortese na",
    "New connection lagbe",
    "ok but the net is still down",
    "thanks, but bill ta bhul",
    "ভাই?",
  ])("%s is a support case (no keyword needed)", (body) => expect(qualifies(body)).toBe(true));

  it("matches whole words only: 'ok' never matches inside another word", () => {
    expect(isOnlyIgnoredWords("book", KEYWORDS)).toBe(false);
    expect(isOnlyIgnoredWords("okhla", KEYWORDS)).toBe(false);
    expect(isOnlyIgnoredWords("token ok", KEYWORDS)).toBe(false);
  });

  it("a phrase must match in order, word for word", () => {
    expect(isOnlyIgnoredWords("you thank", ["thank you"])).toBe(false);
    expect(isOnlyIgnoredWords("thank you", ["thank you"])).toBe(true);
  });

  it("an emoji or sticker with no words is not a case; an attachment without a caption is", () => {
    expect(qualifies("👍")).toBe(false);
    expect(qualifies("")).toBe(false);
    expect(qualifies("", true)).toBe(true);
  });

  it("no keywords configured: every worded message is a case", () => {
    expect(qualifyCustomerMessage({ body: "thanks", hasMedia: false, senderPhone: "1" }, { ignoredKeywords: [], ignoredSenders: [] }).qualifies).toBe(true);
  });

  it("an ignored sender is matched in any number format", () => {
    const s = { ignoredKeywords: [], ignoredSenders: cleanIgnoredSenders(["+880 1711-000000"]) };
    expect(qualifyCustomerMessage({ body: "Maintenance tonight", hasMedia: false, senderPhone: "8801711000000@c.us" }, s)).toEqual({ qualifies: false, reason: "IGNORED_SENDER" });
    expect(qualifyCustomerMessage({ body: "Maintenance tonight", hasMedia: false, senderPhone: "8801711000001" }, s).qualifies).toBe(true);
  });

  it("cleans a settings list: trimmed, lower-cased, de-duplicated, blank lines dropped", () => {
    expect(cleanIgnoredKeywords(["  Thanks ", "", "THANKS", "Thank   You", "!!"])).toEqual(["thanks", "thank you"]);
  });
});

describe("completion: decideReply", () => {
  const base = { status: "ASSIGNED" as const, assignedMemberId: "hasan", assignedAt: 1_000, memberId: "hasan", at: 2_000, onlyIgnoredWords: false, answeredWait: true };

  it("the assignee, after assignment, with real words: COMPLETE (also from OVERDUE)", () => {
    expect(decideReply(base)).toBe("COMPLETE");
    expect(decideReply({ ...base, status: "OVERDUE" })).toBe("COMPLETE");
    expect(decideReply({ ...base, at: 1_000 })).toBe("COMPLETE");
  });

  it("somebody else never completes; if they answered the wait the case closes uncredited", () => {
    expect(decideReply({ ...base, memberId: "borhan" })).toBe("ANSWERED_BY_OTHER");
    expect(decideReply({ ...base, memberId: "borhan", answeredWait: false })).toBe("NONE");
  });

  it("the assignee's message from before the assignment is not a completion", () => {
    expect(decideReply({ ...base, at: 999, answeredWait: false })).toBe("NONE");
    expect(decideReply({ ...base, at: 999 })).toBe("ANSWERED_BY_OTHER");
  });

  it("the assignee's bare 'ok' keeps the case theirs", () => {
    expect(decideReply({ ...base, onlyIgnoredWords: true })).toBe("NONE");
  });

  it("an unassigned case answered by the team closes; an ignored wait answered just closes", () => {
    expect(decideReply({ ...base, status: "UNASSIGNED", assignedMemberId: null, assignedAt: null })).toBe("ANSWERED_BY_OTHER");
    expect(decideReply({ ...base, status: "IGNORED", assignedMemberId: null, assignedAt: null })).toBe("CLOSE_IGNORED");
    expect(decideReply({ ...base, status: "UNASSIGNED", assignedMemberId: null, assignedAt: null, answeredWait: false })).toBe("NONE");
  });
});

describe("SLA", () => {
  const c = { status: "COMPLETED" as const, assignedAt: 0, dueAt: 900_000, completedAt: 600_000, closedAt: 600_000 };
  it("completed on time is MET, late is MISSED, overdue is MISSED", () => {
    expect(slaOutcome(c)).toBe("MET");
    expect(slaOutcome({ ...c, completedAt: 900_001 })).toBe("MISSED");
    expect(slaOutcome({ ...c, status: "OVERDUE", completedAt: null })).toBe("MISSED");
  });
  it("answered by someone else before the deadline is not measured; after it, it is MISSED", () => {
    expect(slaOutcome({ ...c, status: "ANSWERED_BY_OTHER", completedAt: null, closedAt: 100 })).toBeNull();
    expect(slaOutcome({ ...c, status: "ANSWERED_BY_OTHER", completedAt: null, closedAt: 900_001 })).toBe("MISSED");
  });
  it("timestamps decide overdue, not arrival order: a reply sent in time is not overdue though it was marked", () => {
    expect(wasOverdue({ status: "COMPLETED", completedAt: 600_000, dueAt: 900_000, overdueAt: 960_000 })).toBe(false);
    expect(wasOverdue({ status: "COMPLETED", completedAt: 950_000, dueAt: 900_000, overdueAt: 960_000 })).toBe(true);
  });
  it("compliance reads — for nothing measured, never 0%", () => {
    expect(formatSlaCompliance({ met: 0, measured: 0 })).toBe("—");
    expect(formatSlaCompliance({ met: 37, measured: 40 })).toBe("93%");
  });
});

describe("report", () => {
  const caseOf = (over: Partial<ReportCaseInput>): ReportCaseInput => ({
    id: Math.random().toString(36),
    status: "UNASSIGNED",
    groupId: "g1",
    groupName: "ABC",
    assignedAt: null,
    dueAt: null,
    overdueAt: null,
    completedAt: null,
    closedAt: null,
    responseSeconds: null,
    assignedMemberId: null,
    responderMemberId: null,
    events: [],
    ...over,
  });
  const assigned = (member: string) => ({ type: "ASSIGNED" as const, memberId: member });

  it("counts per status, per employee from the assignment history, per group", () => {
    const r = computeSupportAssignmentReport([
      caseOf({ status: "IGNORED" }),
      caseOf({}),
      caseOf({ status: "COMPLETED", assignedMemberId: "hasan", responderMemberId: "hasan", assignedAt: 0, dueAt: 900_000, completedAt: 420_000, closedAt: 420_000, responseSeconds: 420, events: [assigned("hasan")] }),
      caseOf({
        status: "COMPLETED",
        groupId: "g2",
        groupName: "Fibernet",
        assignedMemberId: "borhan",
        responderMemberId: "borhan",
        assignedAt: 0,
        dueAt: 900_000,
        completedAt: 1_200_000,
        closedAt: 1_200_000,
        responseSeconds: 1200,
        overdueAt: 960_000,
        events: [assigned("hasan"), { type: "OVERDUE", memberId: "hasan" }, { type: "REASSIGNED", memberId: "borhan" }],
      }),
      caseOf({ status: "OVERDUE", assignedMemberId: "hasan", assignedAt: 0, dueAt: 900_000, overdueAt: 960_000, events: [assigned("hasan"), { type: "OVERDUE", memberId: "hasan" }] }),
      caseOf({ status: "ANSWERED_BY_OTHER", assignedMemberId: "hasan", responderMemberId: "borhan", assignedAt: 0, dueAt: 900_000, closedAt: 100, events: [assigned("hasan")] }),
    ]);
    expect(r.summary).toMatchObject({ total: 5, ignored: 1, unassigned: 1, assigned: 4, completed: 2, answeredByOther: 1, pending: 1, overdue: 2, avgResponseSeconds: 810 });
    expect(r.summary.sla).toEqual({ met: 1, measured: 3 });
    const hasan = r.employees.find((e) => e.memberId === "hasan")!;
    expect(hasan).toMatchObject({ assigned: 4, completed: 1, pending: 1, overdue: 2, answeredByOther: 1, reassignedAway: 1, avgResponseSeconds: 420 });
    const borhan = r.employees.find((e) => e.memberId === "borhan")!;
    expect(borhan).toMatchObject({ assigned: 1, completed: 1, overdue: 0, reassignedAway: 0 });
    expect(r.groups.find((g) => g.groupId === "g1")).toMatchObject({ cases: 4, completed: 1, answeredByOther: 1, open: 2, overdue: 1 });
  });

  it("an empty period is all zeros and no averages", () => {
    const r = computeSupportAssignmentReport([]);
    expect(r.summary).toMatchObject({ total: 0, avgResponseSeconds: null, sla: { met: 0, measured: 0 } });
    expect(r.employees).toEqual([]);
  });
});

describe("notifications", () => {
  it("every Support Assignment template's default wording is valid and renders without a stray placeholder", () => {
    const keys = NOTIFICATION_TEMPLATES.filter((t) => t.key.startsWith("SUPPORT_ASSIGNMENT_"));
    expect(keys.map((t) => t.key).sort()).toEqual(
      ["SUPPORT_ASSIGNMENT_ASSIGNED", "SUPPORT_ASSIGNMENT_COMPLETED", "SUPPORT_ASSIGNMENT_ESCALATED", "SUPPORT_ASSIGNMENT_OVERDUE", "SUPPORT_ASSIGNMENT_REASSIGNED"].sort(),
    );
    for (const t of keys) {
      expect(validateTemplateBody(t.key, t.defaultBody)).toEqual({});
      const vars = Object.fromEntries(t.variables.map((v) => [v.name, v.sample]));
      expect(renderNotificationTemplate(t.defaultBody, vars)).not.toMatch(/\{\{/);
    }
  });

  it("an unknown placeholder is refused, naming the valid ones", () => {
    expect(validateTemplateBody("SUPPORT_ASSIGNMENT_ASSIGNED", "Hi {{employee_name}}").error).toContain("employeeName");
  });

  it("builds the variables on the Dhaka clock", () => {
    const at = Date.parse("2026-10-06T16:25:00Z"); // 22:25 Dhaka
    const vars = supportAssignmentNoticeVars({
      groupName: "ABC Broadband Support",
      customerName: null,
      customerPhone: "8801712345678",
      message: "Internet   nai\n\nplease",
      employeeName: "Hasan",
      employeeId: null,
      assignedAt: at,
      dueAt: at + 15 * 60_000,
      status: "OVERDUE",
      now: at + 30 * 60_000,
    });
    expect(vars).toMatchObject({
      customerName: "8801712345678",
      message: "Internet nai please",
      assignedTime: "10:25 PM, 6 Oct",
      dueTime: "10:40 PM, 6 Oct",
      overdueBy: "15m 00s",
      status: "Overdue",
      employeeId: null,
    });
  });

  it("formats clock times and response times", () => {
    expect(formatDhakaClock(Date.parse("2026-10-06T06:05:00Z"))).toBe("12:05 PM, 6 Oct");
    expect(formatDhakaClock(Date.parse("2026-10-06T18:05:00Z"))).toBe("12:05 AM, 7 Oct");
    expect(formatResponseTime(452)).toBe("7m 32s");
    expect(formatResponseTime(3_900)).toBe("1h 05m");
  });

  it("dedup keys differ per round, kind and recipient — so a reassignment notifies again, a retry does not", () => {
    const a = supportAssignmentDedupKey(1, "OVERDUE", { memberId: "m1" });
    expect(a).toBe(supportAssignmentDedupKey(1, "OVERDUE", { memberId: "m1" }));
    expect(a).not.toBe(supportAssignmentDedupKey(2, "OVERDUE", { memberId: "m1" }));
    expect(a).not.toBe(supportAssignmentDedupKey(1, "ESCALATED", { memberId: "m1" }));
    expect(a).not.toBe(supportAssignmentDedupKey(1, "OVERDUE", { whatsappGroupId: "m1" }));
  });
});
