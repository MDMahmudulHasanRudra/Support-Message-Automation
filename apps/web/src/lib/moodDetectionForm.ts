import {
  ALERT_PRIORITIES,
  CONVERSATION_BEHAVIOURS,
  MOOD_LABELS,
  MOOD_SENSITIVITIES,
  TRIGGERABLE_MOODS,
  type AlertPriority,
  type ConversationBehaviour,
  type MoodPolicies,
  type MoodPolicy,
  type MoodSensitivity,
} from "@support-automation/shared";

/**
 * Settings → Mood Detection: the form's reading, validation and the audit diff. Plain module (not
 * `"use server"`) so the page, the action and the tests share one parser.
 */

export const MOOD_COOLDOWN_PRESETS = [5, 15, 30, 60] as const;
export const MOOD_POLICY_FLAGS = ["trigger", "notifyTeam", "internalAlert", "mentionMember", "customerMessage", "needsAttention"] as const;

export interface MoodSettingsInput {
  enabled: boolean;
  analyzeText: boolean;
  analyzeEmoji: boolean;
  analyzeStickers: boolean;
  useAiClassification: boolean;
  sensitivity: MoodSensitivity;
  minConfidence: number;
  cooldownMinutes: number;
  internalGroupIds: string[];
  policies: MoodPolicies;
  unassignedMention: "OPTED_IN" | "NONE";
  skipCustomerMessageWhenUnassigned: boolean;
  requireHumanHours: number;
}

export const policyField = (mood: string, field: string) => `policy_${mood}_${field}`;

function intIn(raw: FormDataEntryValue | null, min: number, max: number): number | null {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function parseMoodSettingsForm(formData: FormData): { value: MoodSettingsInput } | { error: string } {
  const on = (name: string) => formData.get(name) === "on";

  const sensitivity = String(formData.get("sensitivity") ?? "BALANCED") as MoodSensitivity;
  if (!MOOD_SENSITIVITIES.includes(sensitivity)) return { error: "Choose a sensitivity." };
  const minConfidence = sensitivity === "CUSTOM" ? intIn(formData.get("minConfidence"), 50, 99) : 80;
  if (minConfidence === null) return { error: "A custom minimum confidence must be a whole number from 50 to 99." };

  const cooldownChoice = String(formData.get("cooldown") ?? "30");
  const cooldownMinutes = cooldownChoice === "custom" ? intIn(formData.get("cooldownCustomMinutes"), 1, 1440) : intIn(cooldownChoice, 1, 1440);
  if (cooldownMinutes === null) return { error: "The cooldown must be a whole number of minutes from 1 to 1440 (24 hours)." };

  const requireHumanHours = intIn(formData.get("requireHumanHours"), 1, 168);
  if (requireHumanHours === null) return { error: "\"Require human takeover\" must hold AI back for 1 to 168 hours." };

  const internalGroupIds = [...new Set(formData.getAll("internalGroupIds").map(String).filter((id) => id.endsWith("@g.us")))];

  const policies = {} as MoodPolicies;
  for (const mood of TRIGGERABLE_MOODS) {
    const flags = Object.fromEntries(MOOD_POLICY_FLAGS.map((f) => [f, on(policyField(mood, f))])) as Pick<MoodPolicy, (typeof MOOD_POLICY_FLAGS)[number]>;
    const conversation = String(formData.get(policyField(mood, "conversation")) ?? "CONTINUE") as ConversationBehaviour;
    const priority = String(formData.get(policyField(mood, "priority")) ?? "MEDIUM") as AlertPriority;
    if (!CONVERSATION_BEHAVIOURS.includes(conversation)) return { error: `Choose what happens to the conversation for ${MOOD_LABELS[mood]}.` };
    if (!ALERT_PRIORITIES.includes(priority)) return { error: `Choose a priority for ${MOOD_LABELS[mood]}.` };
    policies[mood] = { ...flags, mentionMember: flags.mentionMember && flags.internalAlert, conversation, priority };
  }

  const value: MoodSettingsInput = {
    enabled: on("enabled"),
    analyzeText: on("analyzeText"),
    analyzeEmoji: on("analyzeEmoji"),
    analyzeStickers: on("analyzeStickers"),
    useAiClassification: on("useAiClassification"),
    sensitivity,
    minConfidence,
    cooldownMinutes,
    internalGroupIds,
    policies,
    unassignedMention: formData.get("unassignedMention") === "NONE" ? "NONE" : "OPTED_IN",
    skipCustomerMessageWhenUnassigned: on("skipCustomerMessageWhenUnassigned"),
    requireHumanHours,
  };

  if (value.enabled && !value.analyzeText && !value.analyzeEmoji && !value.analyzeStickers) {
    return { error: "Mood Detection is on but reads nothing. Switch on at least one source, or switch Mood Detection off." };
  }
  // A switch that cannot do anything is the dead-setting problem: refuse it rather than save it.
  const needsGroup = TRIGGERABLE_MOODS.filter((m) => value.policies[m].trigger && value.policies[m].internalAlert);
  if (needsGroup.length > 0 && value.internalGroupIds.length === 0) {
    return {
      error: `Choose an internal escalation group, or switch off "Alert the internal group" for ${needsGroup.map((m) => MOOD_LABELS[m]).join(", ")}.`,
    };
  }
  return { value };
}

/** What changed, field by field, for the audit log. Policies are compared per mood and field. */
export function diffMoodSettings(before: MoodSettingsInput, after: MoodSettingsInput): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after) as Array<keyof MoodSettingsInput>) {
    if (key === "policies") continue;
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  for (const mood of TRIGGERABLE_MOODS) {
    for (const field of Object.keys(after.policies[mood]) as Array<keyof MoodPolicy>) {
      const from = before.policies[mood][field];
      const to = after.policies[mood][field];
      if (from !== to) changes[`${mood}.${field}`] = { from, to };
    }
  }
  return changes;
}
