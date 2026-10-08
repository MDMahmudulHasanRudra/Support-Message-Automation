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
  {
    key: "COLLECTION_BROKEN",
    label: "A WhatsApp number has stopped collecting messages",
    description:
      "Sent when a number that should be receiving customer messages is not — a session stuck mid-reconnect, one waiting for somebody to scan a QR, or one reporting itself connected while WhatsApp says otherwise. The only alert here that is about the system rather than a customer.",
    audience: "TEAM",
    variables: [
      { name: "accountLabel", description: "Which WhatsApp number this is.", sample: "Primary Support" },
      { name: "problem", description: "What is wrong, in one line.", sample: "Stuck reconnecting for 41 minutes" },
      { name: "detail", description: "The supporting evidence, if there is any.", sample: "WhatsApp returned no chats at all, which an account in groups cannot truly be." },
      { name: "quietFor", description: "How long since this number last stored a message.", sample: "3 hours 15 minutes" },
      { name: "action", description: "What somebody needs to do about it.", sample: "Open WhatsApp → Accounts and re-link this number with the phone." },
    ],
    // No emoji-free variant and no softening: this is the message that has to survive being
    // glanced at on a phone among a hundred others. The number is named first because with
    // several accounts "which one" is the first thing anybody asks.
    defaultBody: [
      "🛑 MESSAGES ARE NOT BEING RECEIVED",
      "",
      "Number: {{accountLabel}}",
      "Problem: {{problem}}",
      "Last message stored: {{quietFor}} ago",
      "Detail: {{detail}}",
      "",
      "{{action}}",
      "",
      "Customer messages arriving now are not being stored and nobody is being alerted about them.",
    ].join("\n"),
  },
  {
    key: "MOOD_ALERT",
    label: "Mood Detection — customer upset",
    description:
      "Sent when Mood Detection finds a customer angry, very angry, frustrated or urgent enough to act on, under the mood's own settings. Once per escalation: further messages inside the cooldown do not repeat it. Goes to the Notification Center's routing and, when chosen, the internal escalation group.",
    audience: "TEAM",
    variables: [
      { name: "moodLabel", description: "The detected mood, with its emoji.", sample: "😡 Angry" },
      { name: "priority", description: "The alert priority that mood's settings give it.", sample: "HIGH" },
      { name: "confidence", description: "How sure the detection was.", sample: "91%" },
      { name: "groupName", description: "The group the customer wrote in.", sample: "Karnaphuli Broadband" },
      { name: "clientName", description: "Sender's name, or their number if unknown.", sample: "Shoriful Islam Shuvo" },
      { name: CUSTOMER_MESSAGE, description: "The message that triggered it.", sample: "barbar eki problem, worst service 😡" },
      { name: "reasons", description: "Why, as structured reasons — never AI reasoning.", sample: "Strongly negative language, Repeated complaint, Angry emoji" },
      { name: "trend", description: "How their mood moved, if it rose.", sample: "Concerned → Frustrated → Angry" },
      { name: "assignedTo", description: "Who the group is assigned to, or empty if nobody.", sample: "Kazi Sifat" },
      { name: "conversation", description: "What happened to automation in that conversation.", sample: "AI replies paused — rules continue" },
      { name: "mentions", description: "The @-tags, when 'mention the responsible member' is on. Empty otherwise.", sample: "@8801700000000" },
    ],
    defaultBody: [
      "{{moodLabel}} CUSTOMER — {{priority}} PRIORITY",
      "",
      "Group: {{groupName}}",
      "Customer: {{clientName}}",
      "Message: {{customerMessage}}",
      "",
      "Detected: {{moodLabel}} ({{confidence}})",
      "Why: {{reasons}}",
      "Trend: {{trend}}",
      "Assigned to: {{assignedTo}}",
      "Automation: {{conversation}}",
      "",
      "{{mentions}}",
      "Please take over this conversation.",
    ].join("\n"),
  },
  ...moodCustomerTemplates(),
  ...escalationTemplates(),
  ...supportAssignmentTemplates(),
];

/**
 * The optional message to the customer, one per mood so the tone can match: a frustrated customer
 * and a very angry one should not read the same sentence. Off by default in every mood's policy —
 * putting an extra message in front of an upset customer is a decision about tone.
 */
function moodCustomerTemplates(): NotificationTemplateDefinition[] {
  const moods = [
    {
      key: "MOOD_CUSTOMER_FRUSTRATED",
      mood: "frustrated",
      body: "দুঃখিত যে সমস্যাটি এখনও সমাধান হয়নি। আমাদের সাপোর্ট টিম বিষয়টি দেখছে এবং দ্রুত আপনাকে জানাবে।\n\nSorry this is still not sorted — our support team is on it and will update you shortly.",
    },
    {
      key: "MOOD_CUSTOMER_ANGRY",
      mood: "angry",
      body: "আপনার অসুবিধার জন্য আমরা আন্তরিকভাবে দুঃখিত। একজন সাপোর্ট টিম সদস্য এখনই বিষয়টি দেখছেন।\n\nWe are sincerely sorry for the trouble. A member of our support team is looking into this now.",
    },
    {
      key: "MOOD_CUSTOMER_VERY_ANGRY",
      mood: "very angry",
      body: "আপনার অভিজ্ঞতার জন্য আমরা আন্তরিকভাবে দুঃখিত। বিষয়টি অগ্রাধিকার দিয়ে আমাদের সাপোর্ট টিমের কাছে পাঠানো হয়েছে, একজন সদস্য সরাসরি আপনার সাথে কথা বলবেন।\n\nWe are truly sorry. This has been escalated to our support team as a priority, and a person will respond to you directly.",
    },
    {
      key: "MOOD_CUSTOMER_URGENT",
      mood: "urgent",
      body: "আমরা বুঝতে পারছি বিষয়টি জরুরি। আমাদের সাপোর্ট টিমকে জানানো হয়েছে, তারা যত দ্রুত সম্ভব সাহায্য করবে।\n\nWe understand this is urgent. Our support team has been alerted and will help as quickly as possible.",
    },
  ];
  return moods.map(({ key, mood, body }) => ({
    key,
    label: `Mood Detection — message to a ${mood} customer`,
    description: `Posted in the customer's own group when Mood Detection finds them ${mood} and that mood's "Send a message to the customer" is on (off by default). Once per alert. The customer reads this.`,
    audience: "CUSTOMER" as const,
    variables: [
      { name: "groupName", description: "The group this is posted in.", sample: "Karnaphuli Broadband" },
      { name: "assignedTo", description: "Who the group is assigned to, or empty if nobody.", sample: "Kazi Sifat" },
    ],
    defaultBody: body,
  }));
}

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

/**
 * Support Assignment (SUPPORT_ASSIGNMENT.md). One shared set of variables, so a wording edit can
 * move any detail between the five messages. Sent to the assignee (assigned, reassigned), the
 * manager group and admins (overdue, escalated) and admins (completed).
 */
function supportAssignmentTemplates(): NotificationTemplateDefinition[] {
  const variables: TemplateVariable[] = [
    { name: "employeeName", description: "The person the case is assigned to.", sample: "Hasan" },
    { name: "employeeId", description: "Their employee ID, when their login is linked to an employee record.", sample: "EMP-0042" },
    { name: "groupName", description: "The WhatsApp group the customer wrote in.", sample: "ABC Broadband Support" },
    { name: "customerName", description: "The customer's name, or their number if unknown.", sample: "017XXXXXXXX" },
    { name: "message", description: "The customer's message (the first one that is support work).", sample: "Internet nai" },
    { name: "assignedTime", description: "When it was assigned (Dhaka time).", sample: "10:25 PM, 6 Oct" },
    { name: "dueTime", description: "When the SLA runs out (Dhaka time).", sample: "10:40 PM, 6 Oct" },
    { name: "overdueBy", description: "How far past the SLA it is.", sample: "15m 00s" },
    { name: "completedTime", description: "When the assignee replied (Dhaka time).", sample: "10:32 PM, 6 Oct" },
    { name: "responseTime", description: "How long the assignee took once assigned.", sample: "7m 32s" },
    { name: "previousEmployee", description: "Who had it before a reassignment.", sample: "Borhan" },
    { name: "status", description: "The case's status.", sample: "Overdue" },
  ];
  const entries: Array<{ key: string; label: string; description: string; body: string[] }> = [
    {
      key: "SUPPORT_ASSIGNMENT_ASSIGNED",
      label: "Support Assignment — new assignment",
      description: "Sent to a person the moment a support case is assigned to them.",
      body: [
        "🔔 New Support Assignment",
        "",
        "You have been assigned a support task.",
        "",
        "Group: {{groupName}}",
        "Customer: {{customerName}}",
        "Issue: {{message}}",
        "Assigned: {{assignedTime}}",
        "Due: {{dueTime}}",
        "",
        "Please visit the group and complete the support.",
      ],
    },
    {
      key: "SUPPORT_ASSIGNMENT_REASSIGNED",
      label: "Support Assignment — reassigned to you",
      description: "Sent to the new person when a case is moved to them from somebody else.",
      body: [
        "🔁 Support Task Reassigned to You",
        "",
        "Group: {{groupName}}",
        "Customer: {{customerName}}",
        "Issue: {{message}}",
        "Previously: {{previousEmployee}}",
        "Assigned: {{assignedTime}}",
        "Due: {{dueTime}}",
        "",
        "Please visit the group and complete the support.",
      ],
    },
    {
      key: "SUPPORT_ASSIGNMENT_OVERDUE",
      label: "Support Assignment — overdue",
      description: "Sent to the manager group (and admins, if enabled) when the assignee has not replied within the SLA.",
      body: [
        "🚨 Support Assignment Overdue",
        "",
        "Employee: {{employeeName}}",
        "Group: {{groupName}}",
        "Customer: {{customerName}}",
        "Issue: {{message}}",
        "Assigned: {{assignedTime}}",
        "Overdue by: {{overdueBy}}",
        "",
        "No support response has been detected yet. Please check and take action.",
      ],
    },
    {
      key: "SUPPORT_ASSIGNMENT_ESCALATED",
      label: "Support Assignment — escalated",
      description: "Sent to admins when an overdue case is still unanswered after the escalation delay. Once per assignment.",
      body: [
        "🆘 Support Assignment Escalated",
        "",
        "Employee: {{employeeName}}",
        "Group: {{groupName}}",
        "Customer: {{customerName}}",
        "Issue: {{message}}",
        "Assigned: {{assignedTime}}",
        "Overdue by: {{overdueBy}}",
        "",
        "The customer is still waiting. Please reassign or follow up now.",
      ],
    },
    {
      key: "SUPPORT_ASSIGNMENT_COMPLETED",
      label: "Support Assignment — completed",
      description: "Sent to admins (if enabled) when the assignee replies in the group.",
      body: [
        "✅ Support Task Completed",
        "",
        "Employee: {{employeeName}}",
        "Group: {{groupName}}",
        "Completed: {{completedTime}}",
        "Response Time: {{responseTime}}",
      ],
    },
  ];
  return entries.map(({ key, label, description, body }) => ({
    key,
    label,
    description,
    audience: "TEAM" as const,
    variables,
    defaultBody: body.join("\n"),
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
