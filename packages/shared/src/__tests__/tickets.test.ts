import { describe, expect, it } from "vitest";
import {
  decideTicketMove,
  DEFAULT_TICKET_TARGETS as T,
  formatTicketNumber,
  parseTicketNumber,
  readTicketFields,
  readTicketSettings,
  ticketClock,
  ticketDueFrom,
  type TicketStatusValue,
} from "../tickets.js";

const NOW = new Date("2026-11-08T06:00:00Z");
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const ticket = (status: TicketStatusValue, over: Partial<Parameters<typeof decideTicketMove>[0]> = {}) => ({
  status,
  dueAt: hours(10),
  pausedAt: null,
  resolvedAt: null,
  priority: "NORMAL" as const,
  ...over,
});

describe("ticket numbers", () => {
  it("reads what people type", () => {
    expect(formatTicketNumber(12)).toBe("T-0012");
    expect(parseTicketNumber("T-0012")).toBe(12);
    expect(parseTicketNumber("t12")).toBe(12);
    expect(parseTicketNumber("12")).toBe(12);
    expect(parseTicketNumber("line down")).toBeNull();
  });
});

describe("the clock", () => {
  it("each priority has its own target", () => {
    expect(ticketDueFrom(NOW, "URGENT", T)).toEqual(hours(4));
    expect(ticketDueFrom(NOW, "NONE", T)).toEqual(hours(72));
  });

  it("says plainly where a ticket stands", () => {
    expect(ticketClock({ status: "OPEN", dueAt: hours(-2), resolvedAt: null }, NOW)).toMatchObject({ tone: "danger", overdue: true, text: "Overdue by 2h 0m" });
    expect(ticketClock({ status: "OPEN", dueAt: hours(1), resolvedAt: null }, NOW)).toMatchObject({ tone: "warning", text: "1h 0m left" });
    expect(ticketClock({ status: "WAITING_CUSTOMER", dueAt: hours(-2), resolvedAt: null }, NOW)).toMatchObject({ tone: "paused", overdue: false });
    expect(ticketClock({ status: "RESOLVED", dueAt: hours(-2), resolvedAt: NOW }, NOW)).toMatchObject({ tone: "done", overdue: false });
  });
});

describe("moving a ticket", () => {
  it("waiting on the customer stops the clock, and the wait is added back", () => {
    const paused = decideTicketMove(ticket("OPEN"), "WAITING_CUSTOMER", NOW, T);
    expect(paused).toMatchObject({ ok: true, move: { pausedAt: NOW, dueAt: hours(10) } });
    const back = decideTicketMove(ticket("WAITING_CUSTOMER", { pausedAt: hours(-3) }), "IN_PROGRESS", NOW, T);
    expect(back).toMatchObject({ ok: true, move: { pausedAt: null, dueAt: hours(13) } });
  });

  it("resolving records when; closing keeps that time", () => {
    expect(decideTicketMove(ticket("IN_PROGRESS"), "RESOLVED", NOW, T)).toMatchObject({ ok: true, move: { resolvedAt: NOW, closedAt: null } });
    expect(decideTicketMove(ticket("RESOLVED", { resolvedAt: hours(-5) }), "CLOSED", NOW, T)).toMatchObject({ ok: true, move: { resolvedAt: hours(-5), closedAt: NOW } });
  });

  it("reopening starts a new target", () => {
    expect(decideTicketMove(ticket("RESOLVED", { dueAt: hours(-50), resolvedAt: hours(-1) }), "OPEN", NOW, T)).toMatchObject({
      ok: true,
      move: { dueAt: hours(72), resolvedAt: null, closedAt: null },
    });
  });

  it("refuses what makes no sense", () => {
    expect(decideTicketMove(ticket("OPEN"), "OPEN", NOW, T).ok).toBe(false);
    expect(decideTicketMove(ticket("CLOSED", { resolvedAt: NOW }), "IN_PROGRESS", NOW, T).ok).toBe(false);
    expect(decideTicketMove(ticket("RESOLVED", { resolvedAt: NOW }), "WAITING_CUSTOMER", NOW, T).ok).toBe(false);
  });
});

describe("what a form sent", () => {
  it("needs a subject and a known category", () => {
    expect(readTicketFields({ subject: "  " }, []).ok).toBe(false);
    expect(readTicketFields({ subject: "Line down", category: "Made up" }, ["Billing"]).ok).toBe(false);
    expect(readTicketFields({ subject: " Line down ", category: "Billing", priority: "HIGH" }, ["Billing"])).toMatchObject({
      ok: true,
      fields: { subject: "Line down", category: "Billing", priority: "HIGH", dueAt: null },
    });
  });

  it("no priority means normal", () => {
    expect(readTicketFields({ subject: "x", priority: "NONE" }, [])).toMatchObject({ ok: true, fields: { priority: "NORMAL" } });
  });

  it("settings keep whole hours and a clean list", () => {
    expect(readTicketSettings({ urgentHours: "0", highHours: "1", normalHours: "1", lowHours: "1" }).ok).toBe(false);
    expect(readTicketSettings({ urgentHours: "4", highHours: "24", normalHours: "72", lowHours: "168", categories: "Billing\nbilling, Technical\n" })).toMatchObject({
      ok: true,
      categories: ["Billing", "Technical"],
    });
  });
});
