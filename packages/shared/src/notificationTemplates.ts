/**
 * Every message this system sends that a person reads, in one catalogue.
 *
 * Two rules shape this file, and both matter more than they look:
 *
 * **The default text lives in code, not in the database.** No rows are seeded. An absent row means
 * "use the built-in", exactly as an absent `NotificationEventSetting` means "behave as before". So
 * a fresh install works with nothing configured, an unedited template keeps tracking improvements
 * shipped later, and "reset to default" is a DELETE rather than a copy of whatever the default
 * happened to be on the day somebody clicked it.
 *
 * **The catalogue is the list of moments the worker actually has.** Each entry corresponds to a
 * real call site. There is deliberately no way to add a template from the dashboard: a row nothing
 * raises is a message that never sends, configured in a UI that says it will — the dead-setting
 * problem this project keeps removing. A genuinely new alert is a code change, and adding its
 * entry here is one line of it.
 */

/** Where the message goes, which is what decides how careful the wording has to be. */
export type NotificationAudience =
  /** Your own team, in an internal alerts group. Detail is welcome; tone barely matters. */
  | "TEAM"
  /** The customer's own group. They read this. Every word is the company speaking. */
  | "CUSTOMER";

export interface TemplateVariable {
  name: string;
  description: string;
  /** Stands in for the real value in the preview, so the editor shows a realistic message. */
  sample: string;
}

export interface NotificationTemplateDefinition {
  key: string;
  label: string;
  /** When this fires, in the operator's terms — not the function that raises it. */
  description: string;
  audience: NotificationAudience;
  variables: TemplateVariable[];
  defaultBody: string;
}

const CUSTOMER_MESSAGE = "customerMessage";

export const NOTIFICATION_TEMPLATES: readonly NotificationTemplateDefinition[] = [
  {
    key: "AI_HANDOVER_ALERT",
    label: "AI handed over — team alert",
    description:
      "Sent to your alerts group when AI decided it could not answer safely and asked for a person. The most frequent alert this system sends once AI automation is on.",
    audience: "TEAM",
    variables: [
      { name: "groupName", description: "The group the customer wrote in.", sample: "Hamid Net & SoftifyBD" },
      { name: "clientName", description: "Sender's name, or their number if unknown.", sample: "Kazi Sifat" },
      { name: CUSTOMER_MESSAGE, description: "What the customer actually asked.", sample: "partial payment option khuje pacchi na?" },
      { name: "confidence", description: "How sure AI was, as a percentage, or n/a.", sample: "62%" },
      { name: "intent", description: "AI's short label for what was being asked.", sample: "billing question" },
      { name: "reason", description: "Why it handed over, in plain language.", sample: "No verified knowledge covers this" },
    ],
    defaultBody: [
      "🤖 AI ASSISTANCE REQUIRED",
      "",
      "Group: {{groupName}}",
      "Sender: {{clientName}}",
      "Message: {{customerMessage}}",
      "",
      "AI confidence: {{confidence}}",
      "Detected intent: {{intent}}",
      "Reason: {{reason}}",
      "",
      "The AI layer could not confidently reply — please review and respond.",
    ].join("\n"),
  },
  {
    key: "AI_HANDOVER_MENTION",
    label: "AI handed over — message in the customer's group",
    description:
      "Posted in the customer's own conversation, tagging a team member, when 'Also tag a team member' is on in AI Settings. The customer reads this, so it is the one template where tone is the whole point.",
    audience: "CUSTOMER",
    variables: [
      { name: "mentions", description: "The @-tags themselves. Must be kept — removing it tags nobody.", sample: "@8801700000000" },
      { name: "names", description: "The tagged people's names, comma separated.", sample: "Kazi Sifat" },
      { name: "groupName", description: "The group this is posted in.", sample: "Hamid Net & SoftifyBD" },
    ],
    defaultBody: "{{mentions}}\n\nA customer here needs a person — {{names}}, could you take a look?",
  },
  {
    key: "RULE_SUPPORT_REQUEST",
    label: "Rule matched — support request",
    description:
      "Sent when an automation rule with a 'notify WhatsApp' or 'notify Teams' action matches an incoming message.",
    audience: "TEAM",
    variables: [
      { name: "groupName", description: "The group the message arrived in.", sample: "Net Express & ISP Digital" },
      { name: "clientName", description: "Sender's name, or their number if unknown.", sample: "Shoriful Islam Shuvo" },
      { name: CUSTOMER_MESSAGE, description: "The message that matched.", sample: "recharge page asena" },
      { name: "category", description: "The rule's category, if it has one.", sample: "Billing" },
      { name: "matchedRuleName", description: "Which rule matched.", sample: "Recharge page issue" },
    ],
    defaultBody: [
      "🚨 NEW SUPPORT REQUEST",
      "",
      "Group: {{groupName}}",
      "Client: {{clientName}}",
      "Message: {{customerMessage}}",
      "Category: {{category}}",
      "Matched Rule: {{matchedRuleName}}",
      "",
      "Action Required: Please contact the client and resolve the issue.",
    ].join("\n"),
  },
  {
    key: "UNKNOWN_PATTERN",
    label: "Recurring question nothing handles",
    description:
      "Sent by Conversation Learning when the same kind of question keeps arriving and no rule covers it — a suggestion to write one. Aggregated across every occurrence, not one alert per message.",
    audience: "TEAM",
    variables: [
      { name: "keywords", description: "The words the pattern was recognised by.", sample: "bill, generate, invoice" },
      { name: "occurrences", description: "How many times it has come up.", sample: "14" },
      { name: "groups", description: "How many groups it came from.", sample: "6" },
      { name: "clients", description: "How many different people asked.", sample: "9" },
      { name: "confidence", description: "How strong the pattern is, as a percentage.", sample: "88%" },
      { name: "groupName", description: "The most recent group it appeared in.", sample: "Dhaka City Communication" },
      { name: "latestMessage", description: "The most recent example.", sample: "bill kivabe generate korbo?" },
    ],
    defaultBody: [
      "🔍 UNKNOWN PATTERN DETECTED",
      "",
      "Pattern: {{keywords}}",
      "Evidence: {{occurrences}} unhandled occurrence(s) across {{groups}} group(s), {{clients}} client(s)",
      "Confidence: {{confidence}}",
      "Latest group: {{groupName}}",
      "Latest message: {{latestMessage}}",
      "",
      "No existing rule handles this yet — review it in Conversation Learning → Unknown Patterns.",
    ].join("\n"),
  },
  ...escalationTemplates(),
];

/**
 * The five escalation tiers share a body and differ only in their heading, which is the part that
 * carries the urgency. Generated rather than written out five times so a wording change to the
 * shared half cannot land on four of them.
 */
function escalationTemplates(): NotificationTemplateDefinition[] {
  const tiers = [
    { key: "ESCALATION_FIRST", when: "the first SLA timer passes with no human reply", title: "🔔 PRIORITY SUPPORT — New Message" },
    { key: "ESCALATION_SECOND", when: "the customer is still waiting after the first alert", title: "🚨 HIGH PRIORITY SUPPORT — Still Waiting" },
    { key: "ESCALATION_MEMBER", when: "the group's assigned member is reminded directly", title: "🚨 Personal Reminder — Priority Client Waiting" },
    { key: "ESCALATION_ADMIN", when: "it reaches an admin because nobody has replied at all", title: "🆘 ESCALATED TO ADMIN — No Human Response Yet" },
    { key: "ESCALATION_FOLLOW_UP", when: "the case is still unresolved after escalation", title: "🆘 ESCALATION FOLLOW-UP — Still Unresolved" },
  ];

  return tiers.map(({ key, when, title }) => ({
    key,
    label: title.replace(/^\S+\s/, ""),
    description: `Priority Support Escalation, sent when ${when}.`,
    audience: "TEAM" as const,
    variables: [
      { name: "priority", description: "The case's priority tier.", sample: "HIGH" },
      { name: "groupName", description: "The group the customer wrote in.", sample: "Karnaphuli Broadband" },
      { name: "clientName", description: "Sender's name, or their number if unknown.", sample: "Shoriful Islam Shuvo" },
      { name: "waitingMinutes", description: "Minutes since the customer's last message.", sample: "37" },
      { name: CUSTOMER_MESSAGE, description: "The message that opened the case.", sample: "net kaj korche na" },
      { name: "assignedTo", description: "Who it is assigned to, or empty if nobody.", sample: "Kazi Sifat" },
    ],
    defaultBody: [
      title,
      "",
      "Priority: {{priority}}",
      "Group: {{groupName}}",
      "Client: {{clientName}}",
      "Waiting: {{waitingMinutes}} minute(s) since last customer message",
      "Message: {{customerMessage}}",
      "Assigned to: {{assignedTo}}",
      "",
      "Please review the conversation and respond.",
    ].join("\n"),
  }));
}

const BY_KEY = new Map(NOTIFICATION_TEMPLATES.map((t) => [t.key, t]));

export function getTemplateDefinition(key: string): NotificationTemplateDefinition | undefined {
  return BY_KEY.get(key);
}

export function isNotificationTemplateKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** `{{name}}` occurrences in a body, deduplicated, in the order they appear. */
export function extractPlaceholders(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!found.includes(match[1]!)) found.push(match[1]!);
  }
  return found;
}

/**
 * Substitutes values into a template.
 *
 * An unknown placeholder is left standing rather than blanked, matching the Teams notification
 * template this borrows from — a visible `{{typo}}` in an internal alert is a bug report, whereas
 * a silent gap looks like the data was missing. Save-time validation is what stops one ever
 * reaching a customer; this is the backstop behind it.
 *
 * A variable with no value renders empty, and the line it sat alone on is removed. Otherwise an
 * unassigned case leaves "Assigned to:" hanging with nothing after it, which reads like a fault.
 */
export function renderNotificationTemplate(body: string, vars: Record<string, string | null | undefined>): string {
  const substituted = body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in vars)) return match;
    return vars[key] ?? "";
  });

  return substituted
    .split("\n")
    .filter((line, index, lines) => {
      const trimmed = line.trim();
      if (trimmed !== "" && !/^[\w\s]+:$/.test(trimmed)) return true;
      // Drop a label with nothing after it, but never collapse deliberate blank lines — those are
      // the paragraph breaks that keep a long alert readable on a phone.
      if (trimmed === "") return !(index > 0 && lines[index - 1]!.trim() === "");
      return false;
    })
    .join("\n")
    .trim();
}

export interface TemplateValidationResult {
  error?: string;
}

/**
 * Checked before a custom template is saved, because the alternative is discovering the problem in
 * front of a customer.
 */
export function validateTemplateBody(key: string, body: string): TemplateValidationResult {
  const definition = getTemplateDefinition(key);
  if (!definition) return { error: "That template does not exist." };

  const trimmed = body.trim();
  if (!trimmed) return { error: "The message cannot be empty. Use Reset to restore the built-in wording." };
  // WhatsApp's own limit is 4096; alerts anywhere near it are unreadable on a phone anyway.
  if (trimmed.length > 4000) return { error: "The message is too long — keep it under 4000 characters." };

  const known = new Set(definition.variables.map((v) => v.name));
  const unknown = extractPlaceholders(trimmed).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      error: `Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown
        .map((n) => `{{${n}}}`)
        .join(", ")}. Available here: ${definition.variables.map((v) => `{{${v.name}}}`).join(", ")}.`,
    };
  }

  // A required variable is one the message is pointless without. Only the mention tags qualify so
  // far: drop them and the message says somebody was called while tagging nobody at all.
  if (definition.key === "AI_HANDOVER_MENTION" && !extractPlaceholders(trimmed).includes("mentions")) {
    return {
      error: "{{mentions}} must stay in this message — without it nobody is actually tagged, and the customer sees a request for help that reached no one.",
    };
  }

  return {};
}
