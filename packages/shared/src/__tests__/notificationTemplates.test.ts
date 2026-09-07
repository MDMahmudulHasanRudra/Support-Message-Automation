import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TEMPLATES,
  extractPlaceholders,
  getTemplateDefinition,
  isNotificationTemplateKey,
  renderNotificationTemplate,
  validateTemplateBody,
} from "../notificationTemplates.js";

/**
 * Pure — no database, no network.
 *
 * The risk this covers is specific: these strings are sent to customers and to on-call staff, and
 * a template is edited by someone who cannot see the result until it has already gone out. So the
 * things pinned here are the ones whose failure is invisible until it is public — an unknown
 * placeholder surviving to send time, a required tag being removable, an empty value leaving a
 * dangling label.
 */

describe("the catalogue describes what the worker can actually raise", () => {
  it("has a unique key for every template", () => {
    const keys = NOTIFICATION_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only uses placeholders it declares", () => {
    // A default that names an undeclared variable would render as literal {{text}} on a fresh
    // install, before anybody had touched anything.
    for (const definition of NOTIFICATION_TEMPLATES) {
      const declared = new Set(definition.variables.map((v) => v.name));
      for (const used of extractPlaceholders(definition.defaultBody)) {
        expect(declared, `${definition.key} uses {{${used}}}`).toContain(used);
      }
    }
  });

  it("passes its own validator, for every default", () => {
    // Otherwise a default could exist that the UI refuses to save back after an edit and reset.
    for (const definition of NOTIFICATION_TEMPLATES) {
      expect(validateTemplateBody(definition.key, definition.defaultBody).error).toBeUndefined();
    }
  });

  it("gives every variable a sample, so the preview is never half-filled", () => {
    for (const definition of NOTIFICATION_TEMPLATES) {
      for (const variable of definition.variables) {
        expect(variable.sample.length, `${definition.key}.${variable.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("recognises its own keys and nothing else", () => {
    expect(isNotificationTemplateKey("AI_HANDOVER_ALERT")).toBe(true);
    expect(isNotificationTemplateKey("NOT_A_TEMPLATE")).toBe(false);
    expect(getTemplateDefinition("NOT_A_TEMPLATE")).toBeUndefined();
  });
});

describe("rendering", () => {
  it("substitutes declared values", () => {
    expect(renderNotificationTemplate("Group: {{groupName}}", { groupName: "Hamid Net" })).toBe(
      "Group: Hamid Net",
    );
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    // A visible {{typo}} in an internal alert is a bug report; a silent gap looks like missing
    // data and gets investigated as one. Save-time validation is what keeps this off a customer.
    expect(renderNotificationTemplate("Hello {{nope}}", { name: "x" })).toBe("Hello {{nope}}");
  });

  it("drops a label whose only content was an empty value", () => {
    // "Assigned to:" with nothing after it reads like a fault in the system.
    const out = renderNotificationTemplate("Priority: HIGH\nAssigned to: {{assignedTo}}\nEnd", {
      assignedTo: "",
    });
    expect(out).toBe("Priority: HIGH\nEnd");
  });

  it("keeps the label when the value is present", () => {
    const out = renderNotificationTemplate("Assigned to: {{assignedTo}}", { assignedTo: "Kazi Sifat" });
    expect(out).toBe("Assigned to: Kazi Sifat");
  });

  it("treats null and undefined as empty rather than printing them", () => {
    expect(renderNotificationTemplate("A{{x}}B", { x: null })).toBe("AB");
    expect(renderNotificationTemplate("A{{x}}B", { x: undefined })).toBe("AB");
  });

  it("keeps paragraph breaks that make a long alert readable", () => {
    const out = renderNotificationTemplate("Title\n\nBody\n\nFooter", {});
    expect(out).toBe("Title\n\nBody\n\nFooter");
  });

  it("renders the AI handover default into something a person can read", () => {
    const definition = getTemplateDefinition("AI_HANDOVER_ALERT")!;
    const samples = Object.fromEntries(definition.variables.map((v) => [v.name, v.sample]));
    const out = renderNotificationTemplate(definition.defaultBody, samples);

    expect(out).toContain("AI ASSISTANCE REQUIRED");
    expect(out).toContain("Kazi Sifat");
    expect(out).not.toContain("{{");
  });
});

describe("validation stands between an edit and a customer", () => {
  it("refuses a placeholder that belongs to a different template", () => {
    const verdict = validateTemplateBody("AI_HANDOVER_ALERT", "Waiting {{waitingMinutes}}");
    expect(verdict.error).toMatch(/waitingMinutes/);
    // The message has to name what IS allowed, or the person is left guessing.
    expect(verdict.error).toMatch(/groupName/);
  });

  it("refuses an empty body and points at Reset instead", () => {
    expect(validateTemplateBody("AI_HANDOVER_ALERT", "   ").error).toMatch(/Reset/i);
  });

  it("refuses a body too long to read on a phone", () => {
    expect(validateTemplateBody("AI_HANDOVER_ALERT", "x".repeat(4001)).error).toMatch(/too long/i);
  });

  it("refuses to let {{mentions}} be removed from the message customers see", () => {
    // Without it the tags vanish: the customer reads that somebody was called, and nobody was.
    const verdict = validateTemplateBody("AI_HANDOVER_MENTION", "Someone will help you shortly.");
    expect(verdict.error).toMatch(/mentions/);
  });

  it("accepts a rewritten customer message that keeps the tags", () => {
    const verdict = validateTemplateBody(
      "AI_HANDOVER_MENTION",
      "{{mentions}}\n\nAssalamu alaikum — {{names}} ekhoni apnake help korbe.",
    );
    expect(verdict.error).toBeUndefined();
  });

  it("accepts a template that drops placeholders it does not want", () => {
    // Leaving detail out is a legitimate edit — only unknown names are refused.
    expect(validateTemplateBody("AI_HANDOVER_ALERT", "Someone needs help in {{groupName}}.").error).toBeUndefined();
  });

  it("refuses an unknown key outright", () => {
    expect(validateTemplateBody("NOT_A_TEMPLATE", "anything").error).toBeTruthy();
  });
});
